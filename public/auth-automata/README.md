# Login page decoration

Every `.svg` file in this folder is drawn on the sign-in page's brand panel, one at a
time, crossfading to the next every couple of minutes. Add a file to add it to the
rotation, delete one to remove it. Files are read in filename order.

Two rules for a file to be used:

- It needs a `viewBox`. The panel is a fixed 444 x 234 box so the crossfade never shifts
  the layout, and each drawing is fitted into it. A file without a `viewBox` is skipped.
- Draw with `currentColor` to inherit the panel's blue tint, or give the shapes their own
  fills to keep the colours you drew. Either way it renders at the panel's low opacity,
  because this is background decoration and has to stay behind the sign-in form.

## Conventions that give the drawing depth

The panel recolours the parts of a drawing so it has a reading order rather than being one
flat weight: states and their labels in a brighter blue, transitions and their labels in a
darker one. Two solid colours, never partial opacity: a transition line runs underneath its own
arrowhead, so two translucent shapes overlapped there and every arrow came out looking drawn
twice. The wrapper's own opacity is what makes the whole drawing recede.

That styling lives in `globals.css` under `.auth-automaton`, and it finds the parts by what
they are, since the files carry no classes. Follow these and a new drawing gets the same
treatment for free:

| Part                     | How it is drawn                    |
| ------------------------ | ---------------------------------- |
| A state                  | `<circle r="28">`                  |
| An accepting state       | two circles, `r="32"` and `r="26"` |
| A state label (`q0`)     | `<text font-size="18">`            |
| A transition             | `<line>` or `<path>`               |
| A transition label (`a`) | `<text font-size="15">`            |

### Self-loops need their own arrowhead marker

A drawing with a transition from a state back to itself carries a second marker, `…-loop-arrow`,
identical to the ordinary one except for `refX="10"` instead of `refX="8"`, and only the looping
`<path>` points at it.

The reason is where each kind of transition stops. A straight arrow ends short of the state it
points at, so the two units the tip sits past the reference point close a gap. A self-loop's
curve ends exactly on the circumference, so those same two units drive the arrowhead into the
circle and it reads as though it has been drawn through the state. Moving the reference point to
the tip lands the arrow on the boundary the loop actually touches.

Every shape must also sit inside a single top-level `<g>`, with the arrowhead marker in
`<defs>`. That is what lets the styling tell a transition apart from the arrowhead finishing
it, rather than colouring the arrowhead as though it were a line of its own.

None of this is required. A drawing that ignores it still renders, it just renders flat, the
way every drawing did before the styling existed.

The files here are baked into the application image, so adding one takes a redeploy.
