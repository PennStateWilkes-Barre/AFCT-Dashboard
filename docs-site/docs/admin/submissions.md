# Submissions

The **Submissions** page shows every submission across the AFCT installation, including what is still waiting to be graded and what is being graded now. It is useful when an administrator needs to look across courses, or to investigate an evaluator problem that is not limited to one of them.

Problems with the autograder switched off appear here too. They never enter the queue, so their Result reads **Not autograded** rather than a queue state. The **Type** column says whether the work was handed in by a group or an individual.

## Choose the scope

The pickers at the top build on one another:

1. Select one or more courses.
2. Select assignments from those courses.
3. Select problems from those assignments.

Leaving a picker empty means **all of them**, which is why the page opens showing everything. Narrow from the top down: choose courses to unlock the assignment picker, then assignments to unlock the problem picker. Use **Clear Filters** to start over.

The pickers below the one you change keep up with it. Drop a course and the assignments that came with it leave your selection too, so you are never left filtering on something the page can no longer show you. Anything still on offer stays selected, so adding a second course to compare against the first does not cost you the assignment you had already picked.

## Read the table

Each row is one submission, and shows when it arrived, whether it was on time, who submitted it, the course, assignment and problem, the submitted file, the grade, and the grading status. Course, assignment, and problem names link back to the related review pages.

**File** is the student's own file name. Click it to open the submission in the viewer for that problem type, or use the download icon beside it to save the original file. This works the same way as the solution file on a course's problem list.

The viewer opens in a panel over the page, which suits a quick look. It keeps the grid, the zoom controls, **Fit** and **Center**; the layout choice, the exports and undo live in the standalone window instead. For a large machine, **Open in the viewer** on that toolbar puts the same viewer in a browser window of its own, where it has the whole screen and can sit on a second monitor. The panel closes as the window opens, so the same file is never showing in two places.

That window holds several files at once, and can show two of them side by side. Open another machine while it is up and it arrives as a tab beside the first rather than replacing it, so a whole assignment's submissions can be gathered and compared by clicking between them. A file opens showing the whole machine, and comes back at whatever zoom you left it at. Each tab keeps its own arrangement, zoom and undo history. With the window split only one properties panel is shown at a time, on the side you are working in; the other half keeps whatever you had selected and shows it again when you click back into it. Opening something already open selects that tab instead of adding a second copy of it, and the close cross on a tab drops it. Drag a tab along its strip to put the files in whatever order suits you. The window holds twelve files at once; open a thirteenth and the one you opened first closes to make room, and a message says which it was with an **Undo** beside it if you wanted it kept. The strips work from the keyboard too: Tab reaches the file on screen, the left and right arrows move along the strip, Home and End jump to either end, and Enter opens whichever one you land on. Each tab also remembers how you were looking at it across a refresh: reload the page and the zoom, the position on screen and any states you have dragged come back. The undo history comes back with it, so a reload leaves Undo and Redo able to step back through what you had already done rather than greyed out over work that is still on screen; the last 25 steps each way are kept. All of it lasts as long as the window does, so closing the tab or the window forgets it. The window remembers its tabs in its own address, so refreshing restores the same set, and the address can be sent to a colleague who has access to the same files.

To compare two machines, drag a tab to the left or right edge of the drawing. An outline shows the half it will take; let go and the window splits, with each side keeping its own tabs, zoom and arrangement. **View → Move to other side** does the same thing without a mouse. With two machines up, **View → Link the two views** makes them share one camera: zoom or pan the half you are working in and the other follows, which is what you want when comparing two attempts at the same problem. It is off unless you ask for it, because two machines that are not versions of each other rarely sit in the same place and moving one would drag the other somewhere useless. Drag or move the last tab out of a side, or close it, and the window goes back to one. Each half opens its file on its own, so it says what it is doing (loading the file, reading the machine, drawing it) and, if it cannot, says why in that half alone: whether the file is not yours to open, is no longer there, or is not a machine the viewer can read. Where trying again could help, such as a server that was briefly unhappy, there is a **Try again** button; where it could not, there is not one. The other half is unaffected either way.

A coloured bar sits over the file the menus are acting on, split or not: with two machines on screen and one menu bar, that is what says which machine **Reset** or **Download** will mean. A line runs between the two halves. Clicking either half, or dropping a tab into it, moves the menus there.

That window has a menu bar of its own:

- **File → Download** offers two things. **Original file** saves the file exactly as it was submitted. **Current view** saves a new `.jff` with the machine laid out as it is on screen, which is useful after **Auto-arranged** has made a crowded drawing readable. The submitted file is never altered by this.
- **File → Export** saves the drawing as an SVG or a PNG.
- **File → Properties** says where the file came from: whether it is a student's submission or the instructor's solution, the course, assignment and problem, the student who submitted it (and the group, on group work), and when it arrived. It says nothing about grades.
- **Edit** holds **Undo** and **Redo**, which step back through anything you have changed about the drawing: a state dragged to a new place, the layout switched, a state renamed, an initial or final mark ticked, what a transition reads, or a comment written over the machine. Typing into a box is one step for the whole box rather than one per letter, and so is typing into a comment. Zoom and panning are not included, since they move the view rather than the machine.
- **Machine** chooses how the machine is drawn: **As drawn** places the states where their author put them, and **Auto-arranged** lets the layout engine place them. One of the two is always in effect. It also copies the drawing: **Copy as PNG** for a document or an email, and **Copy as SVG** for a drawing program or a slide, where it stays sharp at any size. To copy the machine as words, open **View → Text representation** and use the **Copy as text** button there. **Reset machine** puts everything back the way the file opened: the states return to where their author had them, and the layout, the zoom and the undo history for that machine are forgotten. It asks first, it affects only the machine you are looking at, and it never changes the submitted file.
- **Help** opens this documentation page in a new tab.
- **View** holds **Fit to window**, which brings the whole machine back on screen after zooming or panning about, **Center in window**, which brings it back to the middle at whatever zoom you have set, and **Text representation**, which opens the machine written out as states and transitions in a window of its own. It also turns the background **Grid** on and off, shows or hides the **JFLAP Notes** the author wrote on the canvas (on by default, and only drawn in the As drawn layout), and turns on **Snap to grid**, which makes dragging a state land it on the nearest grid line (off by default, so nothing moves unless you ask for it).

**Select** is the tool the viewer opens on, and it is the viewer as described below: clicking picks things out, dragging moves them. **State** turns a click on empty canvas into a new state, drawn where you clicked and named with the first free `q` number. It stays on so you can place several in a row, and each new state opens its properties so you can name it straight away. Clicking an existing state selects that state rather than putting a second one underneath it, and clicking the palette, the toolbar or the panel never draws anything. Press Escape, or click **Select**, to come back out. The foot of a state's or a transition's properties panel has a **Delete** for it, which asks before it acts: deleting a state takes every transition into and out of it as well. With a state selected, the Delete or Backspace key asks the same question, so you do not have to look down at the panel for it; while you are typing in a box the key belongs to what you are typing. All of it is undoable like anything else here, and like everything else here it changes only what is on your screen: the submitted file is untouched, and **Download this arrangement** is how a marked-up machine leaves.

Renaming a state, moving states about, or switching the layout changes only what is on your screen. Click a state and type over the **Name** in its properties, or tick **Initial state** or **Final state**: the drawing, the panels and the text representation all follow, and the submitted file does not. A machine has one initial state, so ticking it on a state takes it off whichever state had it. A state's panel also lists every transition into and out of it, and clicking one of those rows opens that transition, where what it reads can be typed over, along with what a pushdown automaton pops and pushes or a Turing machine writes and moves. The **X** and **Y** boxes move the state on the canvas, which is how two states are lined up exactly. **Undo** steps back through all of it, names and ticks included, so nothing here has to be got right first time. To make that plain, a quiet **File changed** note appears beside the machine type once you have changed something. Open it and it says the submitted file is unchanged, and offers the two things you might want next: **Download this arrangement**, which saves a new `.jff` laid out as you have it, and **Put it back**, which returns the states to where the file has them. Neither touches what the student submitted; nothing in the viewer writes to it.

Clicking a state opens a properties panel showing its name, whether it is the initial or a final state, and every transition into and out of it, listed under **Outgoing** and **Incoming** with a count on each, so which way one runs is read off the heading rather than each row. A self-loop is listed once, under Outgoing. A direction the state has none of is left out rather than shown empty. Under **Advanced** at the foot of the panel are the state's X and Y on the canvas; it opens expanded, and closing it lasts until you leave the window. A transition's panel is the same shape: which states it runs between, then whatever that kind of machine gives a transition to say. The rest of the machine dims, so what you have selected is the one thing lit: a state on its own, without the transitions running out of it. Clicking a transition does the same for it: which state it leaves and which it enters, whether it is a self-loop, and everything it reads. Where several transitions join the same pair of states they are drawn as one line, so the panel lists all of them. The panel is about 320px wide and floats over the drawing: opaque, rounded, and inset from the edges so the machine runs behind and around it. It slides in as a drawer and slides out again when dismissed. A small tool palette floats opposite it, at the top left of the drawing, holding **Select** and **State**. Where the pane is wide it comes in down the right-hand side, over the drawing rather than pushing it aside, so the machine does not shift under you when you click a state; where it is not, on a phone or in half of a split window, it slides up from the foot of the drawing instead. Either way it covers a strip of the machine, which you can pan out from, and closing it gives that back. Click the background, or the panel's close button, to dismiss it, or press Escape while the close button has the focus. The same information for every state at once is under **View → Text representation**, which is also the way to read it without a mouse.

Resizing the window, or splitting it, never moves you: the zoom stays as you set it and whatever was in the middle of the view stays in the middle, so you keep looking at the part you were looking at. **Fit** is how you ask for the whole machine back, and **Center** brings it back to the middle without giving up the zoom you are working at.

The toolbar keeps **Undo** and **Redo**, then one zoom control: a minus, the current percentage, a slider and a plus, grouped together, with **Fit** beside them to bring the whole machine back on screen and **Center** to bring it back to the middle at the zoom you have set. Anything the menu offers is taken off the toolbar in this window, so nothing appears twice: the grid, the layout and the export buttons all move into the menus. Zoom stays on the toolbar, because the menu has no zoom. They all act on a drawn machine, so they are unavailable for a grammar or a regular expression, which have nothing to draw.

**Grade** is what that one attempt earned: the problem's full points if the evaluator found it correct, zero if it did not, and a dash while the submission is still pending, processing or failed. A student's several attempts therefore show different grades.

**Recorded grade** is the student's standing grade for the problem, the number the gradebook carries. It is the same on every attempt by that student, so it is off by default; turn it on from **Columns** to spot a grade that was entered by hand and no longer matches the latest attempt.

Two columns carry a coloured badge:

- **Timing** is **On time** or **Late**, measured against the problem's due date for that student.
- **Status** is where the submission has got to: **Pending** (queued), **Processing** (being graded now), **Failed** (the evaluator itself could not finish), **Correct**, or **Incorrect**.

**Failed** and **Incorrect** are different problems. Incorrect is an ordinary result, a student answer that did not match. Failed means the evaluator did not produce a verdict at all, which is worth investigating.

The page opens showing everything in scope. It loads one page of submissions at a time, so searching, filtering and sorting all apply to the whole queue rather than to the rows currently on screen, and the count beside the pager is the total number of matches.

To narrow it:

- **Search** matches across the table, or one field if you pick one in the box beside it.
- **Filters** holds **Timing** on one side and **Status** and **Submission** on the other.

  Status and Submission are two headings over one question, because a submission has exactly
  one of those five values. Picking across them means "either": Failed plus Incorrect finds
  both, it does not find submissions that are somehow both.

  Timing is separate and combines with them, so Timing **Late** plus Submission **Incorrect**
  finds late wrong answers.

- **Columns** turns columns on and off, including **Due** and **Recorded grade**, which are off by default. That choice is remembered in your browser.
- Sort by most column headings, including Status. **Timing**, **Type**, **Grade** and **Recorded grade** cannot be sorted: none of them is a stored value (Timing is a comparison against the due date, Grade is worked out from the result, and Recorded grade is kept with the gradebook), so there is nothing to order the whole queue by. Filter by Timing instead.

There is no CSV export here. The page holds one page of results at a time, so an export would have written whatever was on screen rather than everything matching your filters. To get grades out of AFCT, use the [grade export](../faculty/grades.md#export-grades) on a course instead.

## Inspect a submission

Each row has a **Manage** menu:

- **View submission** opens the submitted file in the viewer for that problem type
- **Open in submission review** jumps to the assignment's own review screen, next to the grade box and the discussion
- **View feedback** shows the evaluator's feedback
- **Download** saves the original file
- **Rerun** sends the submission back to the evaluator

A pending or processing submission cannot be rerun yet, and feedback is not available until grading finishes.

Rerunning is per submission. Start with the narrowest useful filter when you are working through a batch: a broad rerun places avoidable work on the evaluator and can make it harder to isolate the original failure. After rerunning, check the updated status and feedback before changing grades manually.

For normal course grading and discussion, use the assignment's [Submissions](../faculty/submissions.md) page instead.
