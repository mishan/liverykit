# The MCP server: propose, never commit

`liverykit --mcp` lets an agent read a car, measure a draft design on it, and
propose changes to the person in front of the fitting editor. This document is
why it is shaped the way it is. [The reference](reference.md#model-context-protocol-mcp)
lists the tools and how to start it.

## The temptation, and what is wrong with it

The obvious MCP server for this project would let a model design a livery: say
what you want, get artwork on a car. It would demo well and it would be a bad
idea, because it contradicts the claim the whole tool rests on.

liverykit exists because **nothing in a texture tells you which bit of it lands
on the sidepod**. The fitting editor exists on top of that because no measurement
says which way is up on a panel or which of its flat parts a design wants; only a
person looking at the car can say. An MCP whose selling point is that it places
your artwork would be a machine confidently doing the one job the tool was built
to say a machine cannot do.

So the question is not *can an agent use liverykit*. It is **which half of the
work is text-shaped**, and the answer is quite a lot of it.

## What an agent is good at here

Treatments describe themselves: 12 of them, 35 options, each with a type and a
written-out default. A design is plain data with a validator that explains its
own refusals. Between them an agent has a vocabulary, a way to write, and a way
to be told it wrote nonsense.

That leaves work genuinely suited to a model:

**Questions with factual answers.** The RSS4 profile is 460 KB describing 44
textures and 425 panels, most of them measured for visibility, distortion,
neighbors and mirrors. "Which panels are readable from trackside, larger than 3%
of the sheet, and on the left" has one right answer and no aesthetic content.
Without the MCP it means reading JSON or writing a throwaway script.

**Drafting.** Gulf colors, number 7, sponsor text along the flanks: a first pass
at a design is worth having even when every placement in it needs moving.

**Cross-checking a profile.** The only numbers in a generated profile that can be
verified independently are track width and wheelbase. An agent that can search
the web can check them against a spec sheet for a car it has never seen.

And one thing it is not good at, which shapes everything below: **deciding
whether a placement looks right.**

## Propose, never commit

The editor is already a local server with a live view of the car and a person
sitting in front of it. So the MCP does not write files and has no copy of the
design of its own. It **proposes into the running editor**, the proposal appears
on screen, and the person throws it away or accepts it, and can then drag it
somewhere better. Save is a button a person presses, as it always was.

The agent does the part that is reading and writing structured text, and the
judgment stays with the person looking at the car.

It also means the MCP inherits every check Save already makes. A proposal runs
the same validation as saving (`designRefusal` and `validateFit`), so one that
could never be saved is rejected when it is made, in front of the agent that can
fix it, not later in front of the person who did not make it.

## Attaching to the editor

`liverykit --mcp` speaks the protocol on stdio, which is how an MCP client
launches a server. It does **not** start an editor of its own. It attaches to
one, by default at `http://127.0.0.1:7391/` (`--editor` to change it), using
`GET /api/build` as the handshake: something is listening, it is liverykit, and
this is which copy of the code it is running.

If nothing answers, the MCP does not fall back to working on files and does not
start a headless editor. It reports that no editor is open and stops. An editor
that stops answering later is reported the same way by every tool, and the
result says so as data, `_meta: { "liverykit/editor": "unreachable" }`, so a
client can end its work instead of reading it as a tool refusing. Before that
existed, an agent kept paying for turns against an editor that was gone.

That refusal is the safety mechanism, so it is stated as a rule: **without an
editor, nothing is proposed.** The check is for the editor's server, not for a
person at it: with the browser closed a proposal is still taken, and waits in the
inbox until a person accepts or discards it. An MCP that quietly worked without
an editor would be the demo version described at the top, arrived at by degrees.

## The proposal inbox

The **browser** owns the working design and fit, and posts them with each
render; the server owns only what is on disk. One writer, no races, and the MCP
must not become a second writer of the same state.

So the server has a small **inbox**, separate from the working state:

```
POST /api/proposal            an agent offers a change; returns an id
GET  /api/proposal            what is pending, if anything
POST /api/proposal/ack        the browser reports accepted or discarded
POST /api/proposal/evaluate   what a proposal WOULD do, measured; nothing is pending
```

The browser polls `GET /api/proposal` once a second while idle. When a proposal
arrives it applies the change to its working copy and shows *Accept* and
*Discard*. Until one is pressed nothing else can change, Undo and Save included,
so the proposal is the top step of the undo stack, which already covers both
files, and Discard takes back exactly that step.

Polling, not server-sent events: SSE adds a connection to keep alive, reconnect
and test, and what is being delivered is a message a person has to read anyway.
A one-second delay is not the bottleneck; the person deciding is.

A proposal is a **diff, not a document**: a list of operations against named
regions. Sending a whole design would make the agent the author of everything it
did not mention, and a stale copy would silently revert edits made in the editor
while the agent was thinking.

```jsonc
{
  "why": "a first pass at Gulf colors, from your brief",
  "design": [
    { "op": "set-palette", "name": "gulf-blue", "value": "#7BB3D9" },
    { "op": "add-region", "surface": "surfaces.body",
      "region": { "id": "stripe-centre", "treatment": "stripe", "tags": ["centre"], "at": [0, 0.4, 1, 0.2], "color": "gulf-orange" } },
    { "op": "set-option", "id": "number-left", "key": "color", "value": "gulf-blue" }
  ],
  "fit": []
}
```

`why` is required. The person is being asked to accept a change they did not
make, and a proposal that cannot say what it is for is one they should not
accept.

## The tools

Fourteen tools in three groups. The boundary between the groups is the design.
[The reference](reference.md#tools) has each tool's options.

**Knowing.** Read-only, no picture needed, nothing proposed.

| tool | answers |
|---|---|
| `describe_car` | textures, bind table with sources, axes, panel and texture counts |
| `find_panels` | panels by tag, visibility, size, distortion, role: the 425-panel problem |
| `list_treatments` | every treatment the design's packs provide, with its described options |
| `list_constraints` | the constraints a region may declare, and what each one enforces |
| `read_design` | the working design as the editor currently holds it |
| `read_fit` | the working fit, and which ids the build would report as stale |
| `report` | what this design would and would not paint on this car |

`read_design` and `read_fit` come from the editor, not from disk, so the agent
sees what the person is looking at, including unsaved work.

**Measuring and seeing.** Also read-only.

| tool | answers |
|---|---|
| `check_fitment` | what is wrong with the design where it actually sits: overlaps, readable areas, size in millimeters, mirroring, coverage, occlusion |
| `find_space` | where on a panel a shape of a given size fits whole, ranked by clearance in millimeters; also lays out a number roundel, a stripe, an aero kit or a band along a flank |
| `render_view` | the rendered texture and placements for one surface, or all of them |
| `render_car` | a picture of the working design on the car, or of its panels, named |

`check_fitment` reports `checked` and `notChecked` separately, because a run that
skipped the geometry checks and a run that passed them produce the same empty
findings list and mean opposite things. Its reply opens with a verdict naming
the worst severity and the counts, because "nine low and one high" otherwise gets
summarized as "some minor findings" by anything reading in a hurry.

`check_fitment`, `render_car`, `read_design` and `read_fit` all take a
`proposal`: they measure or show the design with it applied, and adopt nothing.
A draft is staged by the same code as a real proposal, so one that measures
clean is one the inbox will take.

**Proposing.** Everything here goes to the inbox and nowhere else.

| tool | proposes |
|---|---|
| `propose_design` | add, change or reorder regions; palette, identity and constraints |
| `propose_fit` | placement overrides for this car: `panel`, `at`, `rotate`, `drop` |
| `place_at` | a move named by pointing at a pixel of `render_car`'s picture, proposed as the `panel` and `at` a shift-click there would give |

The operations are data inside the proposing tools, so a new kind of change does
not add a tool, and the tool name always says which file a proposal touches.
`propose_design` also carries `set-constraint`, often the right proposal when
`check_fitment` reports the same problem twice: a constraint states the
requirement once, on the design, for every car, instead of being fixed again per
car.

**What there is deliberately no tool for:**

- *Saving.* No `save_design`, `save_fit` or `build`. A person presses Save. An
  agent that could save could propose and accept in one breath, and the inbox
  would mean nothing.
- *Confirming a binding.* `--explain` ranks candidate bindings, and a person
  confirms one by writing `source: "human"`, by hand or with the editor's
  Bindings panel. That field separates the classifier's proposal, right about
  98% of the time, from a person's confirmation; an agent filling it in would
  erase the only signal that tells them apart. The MCP may *report* the ranking.
  It may not record agreement with it. The Bindings panel's Confirm button posts
  to its own route, `/api/bindings/confirm`, which answers only the editor's
  page, so an agent's proposal is never one string away from the same write.
- *Writing a `.mjs`.* Same rule as the editor, same reason.

## What it refuses

Collected in one place, because these are the parts easiest to lose by accident:

1. **No editor, no service.** If the editor's server does not answer, nothing is
   proposed, and there is no fallback to files or a headless editor. A proposal
   waits in the inbox until a person accepts or discards it.
2. **No writes to disk.** Propose only.
3. **No `source: "human"`,** by any route an agent has. Proposals carrying it are
   refused by the MCP tools and again when the editor applies a proposal
   (`applyProposalDiff`); `test/bindings.test.mjs` checks the second refusal
   still holds alongside the Bindings panel's Confirm button.
4. **Nothing a save would refuse.** Proposals run Save's validation when they
   are made.
5. **No claim to have looked.** The tool descriptions, including the note on
   every tool (`PROMPT_NOTE`), say what the agent can and cannot see:
   `render_car` shows the car, with no environment reflections and one fixed
   light rig. That list has to be kept current as the renderer grows. The
   descriptions are the model's entire understanding of what it is doing, and it
   cannot check them, so an overstated capability is the one bug it will never
   report.

## Seeing: a question answered by use

The first version of this design argued against giving the agent a picture. The
argument was careful and wrong, and how it was wrong is worth keeping.

**The original argument.** A rendered *texture* is the flat sheet the README
opens by saying you cannot judge from. A rendered *car* lives in the browser's
WebGL viewport, in front of a person already. So the profile would be the
agent's eyes: visibility is a ray-cast fraction, distortion is measured from the
model, adjacency says which panels touch. A model reasoning about measurements
beats a model guessing at pixels.

**What happened.** All of that is true, and none of it was enough.

Asked to improve a fit, the agent moved a team name off a race number and into a
part of the same panel where only 11% of the box was on the car. Every number
said the move was fine: the panel was 88% visible, with no distortion. The
measurements were about the panel; the mistake was in a rectangle. `check_fitment`
exists to catch that.

Then three changes to the viewer shipped unverified: a lighting model, a texture
resolution fix, and an alpha pass that made the whole car see-through. Each one
was caught by the person, from a screenshot. No measurement in a profile says
"the car is transparent now".

**So `render_car` exists.** It is not a canvas capture from the browser but a
small software rasterizer in Node, about two hundred lines with no new
dependency. It projects the triangles, keeps a depth buffer, samples the design's
own artwork and shades it the way the viewer does. It found two of its own bugs
in its first minute, an upside-down car and then mirrored text, both invisible in
the algebra and obvious in a picture.

**The original worry is handled by saying what the picture is not.** The tool
description lists its limits instead of leaving them to be discovered. It draws
the car's own textures on the parts a design does not paint, as the build's
`preview.jpg` does; for a while it did not, and the agent checked its work
against a car with gray glass and a gray interior while the editor beside it
showed neither. It answers "does the artwork land where I said it would", not
"is this exactly the game". The prompt note changed at the same time: it used to
tell the agent it could not see the car, which had become false, and an agent
that believes it cannot see will not call the tool built so that it can.

**What did not change.** Seeing is still not deciding. `render_car` reads; it
proposes nothing and writes nothing. The person in front of the editor still
accepts. Giving the proposer eyes leaves propose, never commit untouched.

## How it got here

The server was built in the order that kept risk lowest: the read-only tools and
the protocol first, then the editor's inbox with no tool yet able to fill it,
then the proposing tools with every refusal in place and a test each.

The rest came from use, not from the plan. `check_fitment`, the constraints and
`render_car` came from the failures above. Drafts came from an agent iterating
on its own ([autolivery](https://github.com/mishan/autolivery)): a proposal
reaches the working design only once the browser picks it up and applies it, so
checking right after proposing could measure the design *without* the change,
and with no browser open it could not be measured at all. Letting an agent
accept its own proposals behind a flag was rejected, since it would make the
inbox optional; drafts measure a proposal without adopting it instead.

`find_space` came from a door. On the NSX the top quarter of the door panel's
box is not door and its middle is under the window line, so everything that
placed a roundel "in the middle of the panel" cut its top edge off, and an agent
took to probing the door with tiny rings to find where it was. It says only
where a shape *can* go; where it should go is still the design's decision.

## Implementation notes

MCP over stdio is JSON-RPC 2.0 with a small handshake: `initialize`, then
`tools/list` and `tools/call`. Resources and prompts exist and are not needed
here. That subset is a couple of hundred lines of line-delimited JSON handling,
in `src/mcp/`.

This project keeps a minimal dependency footprint, and the official SDK would
significantly expand the dependency tree for the sake of a handshake. The day
the protocol outgrows the hand-rolled subset is the day to reconsider.

Tool schemas have the same hazard as treatment descriptions: a declared input
that nothing reads, or a read that nothing declared. A test calls each tool with
a recording proxy and compares what it touched against what it advertises.

## Testing

All of it is testable without an agent in the loop:

- The protocol layer takes a request object and returns a response object. Tests
  drive it directly; no subprocess, no model.
- The inbox is HTTP, and the tests start a real editor on port zero, propose,
  read the pending proposal, acknowledge it, and check the working state moved,
  or did not.
- Each refusal has its own test. `source: "human"` matters most, because it
  would fail the most quietly.

## What this does not do

**It does not make liverykit an AI tool.** The CLI and the editor are complete
without it. Somebody who never installs an MCP client loses nothing.

**It does not place artwork well.** It places artwork *plausibly*, in front of
somebody who can see it. Those are different claims, and only the second is
true.

**It does not replace `--explain` or the Bindings panel.** Confirming a binding
stays a person's act.
