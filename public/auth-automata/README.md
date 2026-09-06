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

The panel dims the parts of a drawing by different amounts so it has a reading order rather
than being one flat weight: states and their labels first, transitions and their labels
behind. That styling lives in `globals.css` under `.auth-automaton`, and it finds the parts by
what they are, since the files carry no classes. Follow these and a new drawing gets the same
treatment for free:

| Part | How it is drawn |
| --- | --- |
| A state | `<circle r="28">` |
| An accepting state | two circles, `r="32"` and `r="26"` |
| A state label (`q0`) | `<text font-size="18">` |
| A transition | `<line>` or `<path>` |
| A transition label (`a`) | `<text font-size="15">` |

None of this is required. A drawing that ignores it still renders, it just renders flat, the
way every drawing did before the styling existed.

The files here are baked into the application image, so adding one takes a redeploy.
