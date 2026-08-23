# Plan: an MCP that drives the editor

## The temptation, and what is wrong with it

The obvious MCP server for this project would let a model design a livery: say
what you want, get artwork on a car. It would demo well and it would be a bad
idea, because it contradicts the one claim the whole tool rests on.

liverykit exists because **nothing in a texture tells you which bit of it lands
on the sidepod**. The fitting editor exists on top of that because no measurement
knows which *part* of a panel is flat, which way is up on it, or whether the
middle of a rectangle wraps over a wheel arch — only a person looking at the car
can say. A model with no eyes is in exactly the position this project spent its
whole history saying is untenable. An MCP whose selling point is that it places
your artwork would be a machine confidently doing the single job the tool was
built to say a machine cannot do.

So the interesting question is not *can an agent use liverykit*. It is **which
half of the work is text-shaped**, and the answer turns out to be quite a lot of
it.

## What an agent is actually good at here

Two things changed recently and they change the arithmetic.

Treatments now describe themselves — 12 of them, 35 options, each with a type and
a written-out default. And a design is now plain data with a validator that
explains its own refusals. Between them an agent has a vocabulary, a way to
write, and a way to be told it wrote nonsense. None of that existed before
`docs/authoring.md` was worked through.

What is left over is genuinely suited to a model:

**Questions with factual answers.** The RSS4 profile is 460 KB describing 44
textures and 425 panels. Every one carries a measured `anisotropy`; 416 carry
`visible` and a tag set, 369 know which panels they touch, 276 know their mirror,
233 record the sub-rectangle that is actually readable. "Which panels are
readable from trackside, larger than 3% of the sheet, and on the left" has one
right answer and no aesthetic content whatsoever. Today it means reading JSON or
writing a throwaway script.

**Drafting.** Gulf colours, number 7, sponsor text along the flanks — that is a
first pass at a design, and a first pass is worth having even when every
placement in it needs moving.

**Cross-checking a profile.** The README already names the only numbers in a
generated profile that can be verified independently: track width and wheelbase,
which "are worth a glance against a spec sheet". An agent that can search the web
can do that glance for a car it has never seen. Judgement-light, tedious, exactly
the shape of thing worth automating.

And one thing it is emphatically not good at, which is the reason for everything
below: **deciding whether a placement looks right.**

## The shape: propose, never commit

Since the agent cannot see, the design of this whole thing follows from one
sentence:

> **Don't give the agent eyes. Give its output to the person who has them.**

The editor is already a local server with a live view of the car and a person
sitting in front of it. So the MCP does not write files and does not have its own
idea of the design. It **proposes into the running editor**, the proposal appears
on screen, and the person accepts it, drags it somewhere better, or throws it
away. Save is a button a human presses, exactly as it is today.

That gives the division of labour the honest version of this needs: the agent
does the part that is reading and writing structured text, and the eye stays
where it has always been.

It also means the MCP inherits every refusal the editor already makes.
`designRefusal` and `validateFit` do not need a second implementation, and a
proposal that could never be saved is rejected when it is made rather than at the
end.

## Attaching, and refusing when there is nothing to attach to

`liverykit --mcp` speaks the protocol on stdio, which is how an MCP client
expects to launch a server. It does **not** start an editor of its own.

It attaches to one, by default at `http://127.0.0.1:7391/`, overridable with
`--editor`. `GET /api/build` already exists and returns a build fingerprint and a
start time, so it doubles as the handshake: something is listening, it is
liverykit, and this is which copy of the code it is running.

If nothing answers, the MCP does not fall back to working on files, and does not
start a headless editor. It reports that no editor is open and stops.

That refusal is the whole safety mechanism and is worth stating as a rule rather
than an implementation detail: **the eye is not an optional part of this system.**
An MCP that quietly worked without one would be the demo version described at the
top, arrived at by degrees.

## The proposal inbox

There is a wrinkle. Today the **browser** owns the working fit and the working
design, and posts them with each render; the server owns only what is on disk.
That is a good arrangement — one writer, no races — and the MCP must not break
it by becoming a second writer of the same state.

So the server grows a small **inbox**, and it is not the working state:

```
POST /api/proposal      an agent offers a change; returns an id
GET  /api/proposal      what is pending, if anything
POST /api/proposal/ack  the browser reports accepted or discarded
```

The browser polls `GET /api/proposal` while it is idle — once a second is
plenty for something a person is about to look at anyway — and when one arrives
it applies the change to its working copy, marks the affected regions, and shows
*Accept* / *Discard*. Discard restores the working copy from the undo stack,
which already exists and already covers both files.

Polling rather than server-sent events, deliberately. SSE would be tidier and
costs no dependency, but it adds a connection to keep alive, reconnect and test,
and the thing being delivered is a message a human has to read anyway. A one
second delay is not the bottleneck; the bottleneck is the person deciding.

A proposal is a **diff, not a document**: a list of operations against named
regions. Sending a whole design would make the agent the author of everything it
did not mention, and a stale copy would silently revert edits made in the editor
while the agent was thinking.

```jsonc
{
  "why": "a first pass at Gulf colours, from your brief",
  "design": [
    { "op": "set-palette", "name": "gulf-blue", "value": "#7BB3D9" },
    { "op": "add-region", "surface": "surfaces.body",
      "region": { "id": "stripe-centre", "treatment": "stripe", "tags": ["centre"], "at": [0, 0.4, 1, 0.2], "color": "gulf-orange" } },
    { "op": "set-option", "id": "number-left", "key": "color", "value": "gulf-blue" }
  ],
  "fit": []
}
```

`why` is required, and it is not decoration. The person is being asked to accept
a change they did not make; a proposal that cannot say what it is for is one they
should not accept.

## The tools

Two groups, and the boundary between them is the point.

**Knowing.** Read-only, no eyes needed, no proposal involved.

| tool | answers |
|---|---|
| `describe_car` | textures, bind table with sources, axes, panel and texture counts |
| `find_panels` | panels by tag, visibility, size, anisotropy, role — the 425-panel problem |
| `list_treatments` | every treatment the design's packs provide, with its described options |
| `read_design` | the working design as the editor currently holds it |
| `read_fit` | the working fit, and which ids the build would report as stale |
| `report` | what this design would and would not paint on this car, from `resolveTargets` |

`read_design` and `read_fit` come from the editor rather than from disk, so the
agent sees what the person is looking at, including their unsaved work.

**Proposing.** Everything here goes to the inbox and nowhere else.

| tool | proposes |
|---|---|
| `propose_design` | add, change or reorder regions; palette and identity |
| `propose_fit` | placement overrides for this car — `panel`, `at`, `rotate`, `drop` |

Two tools, not ten. The operations are data inside them, so adding a kind of
change does not add a tool, and the agent cannot be confused about which file it
is writing to: the tool name says it.

**What there is deliberately no tool for:**

- *Saving.* Not `save_design`, not `save_fit`, not `build`. A person presses
  Save. An agent that could save could undo the entire point of the inbox by
  proposing and accepting in one breath.
- *Confirming a binding.* `--explain` ranks candidates and a human writes
  `source: "human"`. That field exists to separate a machine's proposal —
  right about 98% of the time — from a person's confirmation, and an agent
  filling it in destroys the only signal that tells them apart. The MCP may
  *report* the ranking. It may not record agreement with it. Both shipped
  profiles are 20-and-0 and 13-and-1 human to auto; that ratio is the work.
- *Writing a `.mjs`.* Same rule as the editor, same reason.

## What it must refuse

Collected in one place, because these are the parts that would be easiest to
lose by accident later:

1. **No editor, no service.** The eye is load-bearing.
2. **No writes to disk.** Propose only.
3. **No `source: "human"`.** Ever, by any route.
4. **Nothing a save would refuse.** Run `designRefusal` and `validateFit` at
   proposal time, so a bad proposal fails in front of the agent that can fix it
   rather than in front of the person who did not make it.
5. **No claim to have looked.** The tool descriptions must say plainly that the
   agent cannot see the car, because those descriptions are the model's entire
   understanding of what it is doing. This is the one place where a prompt is
   part of the software.

## Seeing: the open question

The obvious next thought is to hand the agent a picture. It is worth writing down
why that is not in this plan rather than leaving it to be re-proposed.

A rendered **texture** is cheap — `renderTexture` already produces one in about
two milliseconds — and is precisely the artefact the README opens by saying you
cannot judge from. Giving a model the flat sheet would be giving it the exact
misleading view the project was built to replace.

A rendered **car** is the one that would answer the question, and it lives in the
browser's WebGL viewport. The editor could plausibly hand back a canvas capture
on request, and the browser test harness already proves a headless GL stack is
achievable. But the marginal value is small precisely because the architecture
above already put a person in front of that exact image, and the cost is an
invitation to the failure mode this whole document is arranged against.

The better framing: **the profile is the agent's eyes, and for the questions that
have answers it is better than a screenshot.** `visible` is a ray-cast fraction.
`anisotropy` is measured from the UV-to-3D Jacobian. `adjacent` says which panels
touch on the car. A model reasoning about those is reasoning about measurements;
a model looking at a render is guessing, with more confidence.

## Implementation notes

MCP over stdio is JSON-RPC 2.0 with a small handshake — `initialize`, then
`tools/list` and `tools/call`. Resources and prompts exist and are not needed
here. That subset is a couple of hundred lines of line-delimited JSON handling.

Which matters, because this project keeps a minimal dependency footprint and says so
out loud. Taking the official SDK to expose eight tools would significantly expand
the dependency tree for the sake of a handshake. Hand-roll
the subset, keep it in `src/mcp/`, and treat the day the protocol outgrows that
as the day to reconsider — not before.

The tool schemas have the same shape of hazard as the treatment descriptions: a
declared input that nothing reads, or a read that nothing declared. The same
answer applies, and it worked well enough to be worth reusing — a test that calls
each tool with a recording proxy and compares what it touched against what it
advertises.

## Testing

Everything here must be testable without an agent in the loop, which it is:

- The protocol layer takes a request object and returns a response object. Tests
  drive it directly; no subprocess, no model.
- The inbox is HTTP, and the existing tests already start a real editor on port
  zero and talk to it. A test can propose, read the pending proposal, ack it, and
  assert the working state moved — or did not.
- The refusals get one test each, and each should fail with its guard removed.
  Especially `source: "human"`, which is the one that would be quietest.

## What this does not do

**It does not make liverykit an AI tool.** The CLI and the editor stay complete
without it. Somebody who never installs an MCP client loses nothing, which is the
test of whether this is a feature or a fashion.

**It does not place artwork well.** It places artwork *plausibly*, in front of
somebody who can see it. Those are different claims and only the second one is
true.

**It does not replace `--explain`.** Confirming a binding stays a human act.

## Shape of the work

**1. Knowing. (Done)** The read-only tools and the stdio plumbing, attached to a running
editor. Nothing can be changed by anything in this step, which makes it a safe
place to find out whether the protocol layer is right. Useful on its own: asking
a 425-panel profile a question in conversation is worth having by itself.

**2. The inbox. (Done)** `POST /api/proposal`, the browser's poll, Accept and Discard
wired to the existing undo stack. Still no proposing tool — this step is the
editor learning to receive one.

**3. Proposing. (Done)** `propose_design` and `propose_fit`, with every refusal in place
and a test each.

**4. Judgement.** Only after using it: whether the agent should ever be handed a
car render, and whether `find_panels` grew the right filters. Both are questions
that a plan cannot answer and a week of use can.

The order is deliberate. Step 1 is the whole protocol surface with none of the
risk, and if it turns out an agent asking questions about a car profile is the
only genuinely useful part, that is a fine place to stop.
