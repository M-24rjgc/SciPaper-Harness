# Agent Note: Knowledge items as links in the assistant's reply

Status: implemented

English | [中文](2026-10-02-knowledge-links-in-assistant-text.zh.md)

## Problem

The [Conversation view and the tool-card chips](2026-10-02-knowledge-graph-turn-trace.md) show what the agent touched in a turn, but the person reads the reply, where the agent names the same patterns, papers and relations in prose. The design asks for those names to be chips inside the reply: a used node as a teal chip, a node the person marked not relevant struck through, a relation as a blue chip, each focusing its node in the Conversation view. The first version could not draw them, because the shared Markdown renderer keeps only HTTP(S), mailto and local file links and its delegate has no way for a feature to claim another scheme. The chips also must not become a way for untrusted model text to produce a live link, a click target for something the agent never touched, or a chip that disagrees with the person's marks.

## Decision

**The agent writes an ordinary Markdown link with the `kg:` scheme, and a feature claims the scheme through a keyed slot.** `[MoBA](kg:ai:paper:42)` carries the id the knowledge views already use: a mark's id (`<graph>:<kind>:<id>`), a relation entity's id (`method:fixed-blocks`) or a relation's id (`compares-with:method:a>method:b`). These spaces do not overlap, so the id follows the scheme without a type prefix, and the model copies it as it read it.

**The renderer offers dropped links to the owner and never makes an anchor from them.** `MarkdownDelegateProvider` gains `renderSchemeLink(link, fallback)`. In settled text, every link that the protocol allowlist drops, whose scheme is neither HTTP(S) nor mailto and that is not a local file, goes to it with the lower-case scheme, the destination exactly as authored and the link's plain text, and the node it returns is drawn in place of the link's content. Without a provider, or when the provider returns `fallback`, the output is what it was: the link's content. Streaming text is never offered, because frozen blocks cache elements and the owner's resolution can change while a message grows; the chip appears when the message settles. The `fileMentions` and `pathImages` vocabularies follow the same settled-only gate.

**ui-chat declares the keyed slot `conversation.message.link`.** The chat view passes the delegate a callback that renders the slot with the scheme as `entryKey`, the link as owner values and the link's content as `fallback`. A scheme with no cell therefore draws as today. The cell is a registered component, so it gets the standard session hooks and its own `inject` face, which a resolver function returning plain data could not give it: the chip has to follow the chat and the marks after it is drawn. ui-research registers the key `kg`.

**The slot outlet draws a `span` inside a paragraph.** Every render site is wrapped in a layout-neutral anchor element, a `div`, and a `div` inside a `p` is invalid nesting that React reports in development builds. `renderSlot` takes `inline: true` (`RenderOpts` in ui-slots, the anchor choice in ui-renderer), and the chat view sets it.

**A chip exists only for an id that the current conversation's own calls touched.** The cell reads the conversation through `useChat`, searches the knowledge calls of the loaded turns, newest turn and newest call first, and takes the first settled, successful `research_knowledge` call whose trace holds the id as a node or as a relation (`linkValues.ts`). A made-up id, an id from another conversation, a malformed or empty destination and a call that failed all draw the link's label as plain text with no link and no styling. The destination is looked up by exact id (and by its percent-decoded form when it has escapes); it is never followed. The lookup is a selector with an equality check, so a chip renders again only when what it names changes.

**The chip's look is read now, from the marks.** A node of a graph is struck through while the person's marks as they stand now call it not relevant, outlined while they pin it, and plain while the person has paused the agent following them, the same source and rules as the tool-card chips (`verdictOf`). The cell reads the shared marks store and asks for the marks once a chip names a node of a graph, and again when the research record changes, because the agent marks through its own calls, which the store does not see. A relation's chip is blue. The chip is a real `button` with an accessible name (`MoBA, pinned`, `Relation: …`) and a title that names what the id is, in both languages.

**A click opens the Conversation view on the call that touched the id.** It calls the same `openKnowledge({ call, node })` the tool-card chips call; a relation's click focuses its first end. The chip shows the agent's own words, which read in the sentence, and the title shows the name the trace holds, so a label that does not match its id can be seen.

**The model is told, and each id it may cite is in a result it read.** The `research_knowledge` description and the `research-knowledge` skill say to write an item as `[name](kg:<id>)`, to use only ids a call returned in this conversation, never to invent one, and to write the name as plain text otherwise. A recall result gives each pattern and paper a `link` (`kg:<graph>:<kind>:<id>`, built from the same pieces as the trace's node id); a marks listing already carries each mark's `id`; the neighbourhood already listed each relation's id in brackets and the path text now lists one per hop; an entity's id is the `<from>` or `<to>` part of a relation id. No other result changed.

## Alternatives considered

**Guess names in the reply.** The reply is the model's wording; matching names would draw chips for nodes the agent did not use ([rejected before](2026-10-02-knowledge-graph-turn-trace.md)).

**Let the sanitizer pass `kg:`.** The renderer would then make live anchors from untrusted text and every feature scheme would need a renderer change. The allowlist stays closed; the owner decides what a dropped link becomes, and the renderer makes nothing clickable.

**A resolver in the delegate, like `fileMentions`.** The resolver returns a descriptor the renderer draws. It cannot follow the marks or the chat after it was called, because a function in a props object holds no subscription and a component may not subscribe on its own, so the chip would go stale after an undo.

**A Cordis service that tells the chat which schemes are claimed** (the way `chatKnownFilePaths` tells it which files are known). It would keep the DOM of an unclaimed link exactly as before, at the price of a second registration for each feature. The slot's `fallback` already draws an unclaimed link as its text; the only trace left is an inert `span` around it.

**A `div` outlet in the paragraph.** It works in the browser and logs an invalid-nesting error in development builds, and copying or reparsing the HTML would split the paragraph.

**A type prefix such as `kg:relation:<id>`.** The three id spaces cannot collide, so the prefix gives the model one more thing to get wrong.

**Draw the label the trace holds instead of the agent's.** Short names read in a sentence and the trace's labels are whole paper titles; the title attribute shows the trace's name.

## Consequences

A settled message that has a link with a scheme nobody claims (`ftp:`, `javascript:`, a made-up one) now holds an inert `span` with `display: contents` around the link's text; the text, the layout and the lack of a link are unchanged. Messages without such a link render exactly as before, and the pinned DOM fixtures of the renderer are untouched.

Each chip runs a selector over the loaded turns on every chat change. A found id stops at its call; a made-up id scans the loaded window. The cost grows with the number of chips and loaded tool rows, and a long transcript with many chips would be the place to add an index.

One feature owns a scheme: a second cell registered under `kg` replaces the research's. A reply from an earlier conversation, or a loaded window that does not reach back to the call that touched an id, shows that link as plain text. A relation's chip focuses only its first end, and a node past the fourteen the picture draws is not in it, so its chip opens the view with nothing selected.

A default recall result grows by about ten tokens for each of its sixteen items, and a path by about ten for each hop. The description and the skill add a short paragraph each. The tool schemas sit at the head of the request and change only with a build, so within one build the prefix stays reusable.

Pinned by the renderer specs (what is offered, what is not, streaming, escapes, labels), the ui-chat spec for the slot call, the renderer spec for the inline outlet, the research specs for the lookup, the chip and its registration, the host specs for the ids and the description, and by running the product on a copy of a research home with a recorded conversation, in both languages: the four chip looks, plain text for a made-up node, a made-up relation and a `javascript:` link, a click and an Enter key focusing the node, and the chips following the paused switch and an undone mark.
