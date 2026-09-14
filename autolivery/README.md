# autolivery

An agent that paints race cars. Give it a brief; it designs a livery, fits it to
the car's real 3D model, and revises until the fitment check passes. Every call it
makes is traced, and a person accepts or discards what it proposes.

The fitment check is the part it cannot talk its way past. It measures in
millimetres and visible fractions against the car's actual UV geometry, not by
judging a picture, and the harness runs it rather than the agent reporting on
itself.

liverykit is the toolkit this drives, and most of it predates this directory: the
kn5 reader, profiles, treatments, the editor, the MCP server, `check_fitment` and
`render_car`. What is new here is the loop, the critic, the tracing, and the one
capability the MCP server lacked: measuring a draft without proposing it.

## Running it

```sh
npm install                              # liverykit, from the repository root
(cd autolivery && npm install)           # the agent's one dependency, the Anthropic SDK
export ANTHROPIC_API_KEY=...
export AGENTOPS_API_KEY=...              # optional

node bin/liverykit.mjs autolivery-nsx --ui          # the editor, in another terminal
node autolivery/bin.mjs "Gulf-style, number 85, Neon Doll Racing, number readable from trackside" \
  --critic-model claude-sonnet-5
```

The critic is the planner's model unless told otherwise. On the critic eval
below, Sonnet 5 agreed with a person as often as Opus 5 at half the price, so
the example asks for it.

`autolivery-nsx` is the Honda NSX GT3 Evo in grey primer and nothing else. The
editor needs the car's own `.kn5` for the 3D views, and so does the loop, because
every measurement and render is taken from the model — see the main README on
[supplying the game's files](../README.md#you-supply-the-games-files).

Each round prints its tool calls and the gate's verdict. Renders, `trace.jsonl`
and `result.json` go to `autolivery/runs/<time>/`, and so does `index.html`: every
round as it lands, newest first, with the picture the gate judged and why it
passed or failed. It reloads itself until the run ends; open it beside the editor
to watch the drafts the inbox never sees. `--help` lists the options:
number of rounds, models, effort, whether the critic gates or only advises, and
which views it judges.

## On your own GPU

The planner and the critic can each be any model behind an OpenAI-compatible
`/v1/chat/completions` endpoint: llama.cpp's `llama-server`, Ollama, vLLM, or a
workstation reached over a VPN. They get the same prompts and the same gate as
Claude, so the fitment check holds a small model to exactly the same standard.

The critic has to see renders, so it needs a vision model with its image
projector loaded. The planner works either way: a model that takes no images is
told a render was taken and gets the critic's notes instead. For example, one
vision model serving both roles, split across two cards:

```sh
llama-server -m qwen3-vl-30b-a3b-instruct-q8_0.gguf \
  --mmproj mmproj-qwen3-vl-30b-a3b-instruct-q8_0.gguf \
  -ngl 999 -sm layer -c 65536 -np 1 -fa on -ctk q8_0 -ctv q8_0 \
  --load-mode none --host 127.0.0.1 --port 8081

node autolivery/bin.mjs "..." --backend openai --base-url http://127.0.0.1:8081/v1
```

On two 7900-class cards that loads in seconds and generates at about 50 tokens
a second. `--load-mode none` (`--no-mmap` on older builds) reads the model
straight into the GPUs instead of memory-mapping it. On a machine short of RAM,
a memory-mapped 33 GB file was read one and a half times over, and then the
load stalled.

A run needs about 32k tokens of context per request, and more over six rounds.
`llama-server` divides `-c` among its `-np` slots, so `-c 32768 -np 16` gives each
request only 2k; autolivery reads the per-request figure and warns when it is
short. `--critic-backend` and `--critic-base-url` put the critic somewhere else,
e.g. Claude judging a local planner's work. Self-hosted calls are counted in
tokens and reported as not priced, rather than as free.

## How it works

```
brief ─► planner (Claude) ──── tools ────► autolivery loop
                                              │  its DRAFT: a list of proposal operations
                                              │
                                              │  MCP over stdio
                                              ▼
                                         liverykit --mcp ──HTTP──► editor (--ui)
            describe_car · find_panels · list_treatments · list_constraints
            check_fitment { proposal } · render_car { proposal }  ← measure a draft, adopt nothing
                                              │
            gate, run by the loop every round:
              ├─ check_fitment: no high or fatal finding, and every check ran
              ├─ critic (a vision model, on a contact sheet of six views):
              │    { reads_at_distance, number_legible, palette_ok, matches_brief,
              │      requirements: [{ asked, present, where }], cut_off, unreadable, notes }
              └─ second look, only when fitment passed and the critic did not:
                   the referee, shown full-size side views and what was flagged
                                              │
            fail ─► both verdicts, as data, to the planner ─► next round (6 at most)
            pass ─► propose_design ─► editor inbox ─► a person: Accept / Discard ─► Save
```

Every model call and tool call is a span: in `trace.jsonl` always, and in AgentOps
when `AGENTOPS_API_KEY` is set. The run ends with rounds, calls, tokens, cost at
list price, and the AgentOps link.

Neither verdict is prose. A fitment failure names the region, the panel and the
measurement ("`number-left` is 7 mm across on the car"). The critic answers four
yes/no questions, lists each thing the brief asked for as there or not and where,
and names concrete problems. Nothing in the loop accepts "looks fine" as an
answer.

Nor can the planner tune its way through. A constraint it set that failed one
round, lowered the next, fails that round too: "move or resize it instead". The
first Claude run passed by lowering its own door-number floor from 95% to 90% on
the car, and the roundel went onto the car cut in half by the shut line the
check had found.

The critic judges a contact sheet: six labelled views in one picture, top and front
among them, because a stripe drawn across the bonnet instead of along it was
ticked present by a critic that had only glimpsed the bonnet from an angle. The
planner may ask for one too, and gets two looks a round (`--looks`), because a
look is a turn and a turn re-reads the whole conversation. For the same reason
the harness asks describe_car, list_treatments, list_constraints and find_panels
itself before round 1 and puts the answers in the planner's first message
(`--no-seed` leaves that to the planner).

The critic is a separate call that never sees the planner's reasoning, only the
renders, the brief and the planner's one-line account. With `--advisory-critic`
its verdict is logged and fed back but does not gate, which leaves fitment as the
only hard gate.

A critic can be wrong the other way too. A local one failed three rounds of one
run on a roundel that was whole in every render and a team name that was on the
car but small in what was then a sheet of four views, and the planner, believing it, shrank the
roundel each time. So when a draft measures clean and the critic alone fails it,
the gate takes a second look: full-size left and right views, the list of what
was flagged, and the whole brief judged again. The second verdict decides, and
both are kept. `--referee anthropic`, the default when there is a key, asks
Claude beside a local critic; `critic` asks the critic again; `none` turns it
off. A round that failed fitment costs no second look.

Most of those false alarms were one mistake: a whole roundel called "cut off". The
renders are liverykit's own, so whether a piece is whole in a view is a count, not a
judgement. `check_fitment` on a draft draws each view twice more, with no shading:
once for the whole car, keeping which triangle and texture coordinate each pixel
shows, and once per number, word or ring with nothing in front of it. Pixels of the
piece in the second that the first also shows are seen. The piece is judged in the
view that shows most of it, and a piece that asked for `minVisible` and is partly
behind something there is `hidden-in-view`, which names the mesh in the way. The
critic is told the counts, and names a piece's id when it calls it cut off. The gate
then drops any "cut off" whose id was measured whole and has no high fitment finding
against it, and keeps it in the record as `overruled`. The pieces the count covers
are text (by its letters, not its box), rings, and anything declaring `minVisible`.
It costs about a second for six views.

The planner hears a failed round as `mustFix` (what failed it, from fitment and
from the verdict's lists) and `advice` (everything else the critic said). Told
everything at once, it acted on everything: a note that a Gulf livery's centre
stripe was "broken where it crosses the roof" failed nothing, and the planner
shortened the stripe twice and then deleted it. It is told to fix every mustFix
item, to take advice only if nothing the brief asks for is lost, and to repair a
flagged element rather than delete it. For a brief that names a style, the critic
lists that style's signature elements as requirements of their own, so deleting
one fails the round instead of passing it.

## Testing without paying

Most changes here are to the harness, not the model, and a paid run is a slow and
dear way to test one. Two tools test against real work for nothing.

`--replay <run dir>` puts back what a real run drafted, round by round, and judges
it with today's gate: fitment, renders, and the local critic and second look. It
takes no brief and no planner model, and it proposes nothing. A run records each
round's draft and summary in `result.json`. One from before that replays its final
draft as one round.

    node autolivery/bin.mjs --replay autolivery/runs/<run> --critic-base-url http://127.0.0.1:8081/v1

`node autolivery/eval.mjs` scores a critic against `critic-cases.json`: renders from
real runs, each with a verdict a person gave or checked by eye. It runs the local
critic by default, so a prompt change is tried against every past mistake before a
paid run finds a new one. The renders stay in `runs/`, which is not committed, so a
case whose pictures are missing is skipped, and a run that judged none fails. On
its first run the local critic agreed with the person on 2 of 8. It called a whole
roundel "cut off" in 4 of the 6 cases that had one, and those false alarms account
for most of the wasted rounds. Claude as the critic (`--critic-backend anthropic`)
agreed on 7 of 8, Opus 5 and Sonnet 5 alike; both missed a stripe drawn across the
car where the brief meant one along it.

## The trust boundary

**The agent never commits anything.** It works on a draft: the same list of
operations a proposal carries, which the editor measures and renders on request
and never adopts. Only a draft that has passed the gate is sent, as one ordinary
proposal, to the editor's inbox. Accepting it is a button a person presses, and
saving is a second one.

That was a choice between two options. A proposal reaches the working design only
once accepted, so the obvious way to let an agent iterate unattended is a flag
that lets it accept its own proposals. That flag would turn off the one guarantee
the inbox exists to give: whatever a person sees on the car is something a person
agreed to. Measuring a draft needed only that the editor learn to answer questions
about one, and every MCP client now gets that ability. So the demo and production
run the same code, and there is no flag to forget.

What the agent cannot do is enforced by the MCP server, not by this directory. It
cannot save, write files, confirm a binding, or send a proposal the editor would
refuse. See [docs/mcp.md](../docs/mcp.md).

## Nothing in the loop knows it's a car

`loop.mjs` knows about a draft, a set of tools, a measurement that passes or
fails, and a critic that looks at pictures. Cars, liveries and race numbers are in
the prompts and in the comments that record what went wrong, and nowhere in the
loop's logic. A plane, a bottle or a
jersey would be the same problem with a different profile.
