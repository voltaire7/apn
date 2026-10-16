# Browser HTML

Build a standalone browser app (Deno with `deno bundle` support required):

```sh
apn --html examples/browser/counter.apn counter.html
open counter.html
```

`apn examples/browser/counter.apn` only evaluates its definitions and exits.
The `--html` command embeds the APN interpreter, source, standard modules, and
the local modules the program imports and the files it loads by a literal path
(`load "helpers"`), with what those import and load in turn, into one HTML
file. A `load` of a computed path (`Dynamic $ load ("levels/" ++ name)`) can
name any file, so once the program or a file it uses has one, the build
bundles every `.apn` file in the program's folder and its subfolders (hidden
folders excepted). Only files inside the program's folder are bundled; a
`load` of a file outside it fails with "not bundled".
Open that file in a browser; no server or runtime download is required.
Rebuild and refresh after editing the APN source.

The programs follow [the Elm architecture](https://guide.elm-lang.org/architecture/).
`examples/elm` recreates all of [Elm's examples](https://elm-lang.org/examples)
this way (see [the examples site](#examples-site-and-editor)).

## Sandboxes

```apn
import "html"
browser = import "browser"

Msg = Increment | Decrement

update msg model = match msg [
    Increment -> model + 1
    Decrement -> model - 1
]

view model = div [] [
    button [onClick Decrement] [text "-"]
    div [] [text (to String model)]
    button [onClick Increment] [text "+"]
]

main = browser.sandbox [init: 0, update: update, view: view]
```

`init` is the initial model. A click sends its message to `update msg model`;
the resulting model is passed to `view`. Multiline lists need no commas.
Inside an enclosing parenthesized expression, existing APN layout rules suppress
newlines; use commas there or bind the view separately, as above.
`main` may also be a view alone (`main = text "Hello!"`).

## Elements: commands and subscriptions

`browser.element [init, update, view, subscriptions]` is a program with
effects, as Elm's `Browser.element`. `init` is `[model, command]`, `update msg
model` returns `[model, command]`, and `subscriptions model` names the events
the program listens to:

```apn
import ["html","time"]
browser = import "browser"
task = import "task"

Msg = Tick Posix | AdjustTimeZone Zone

init = [[zone: utc, time: millisToPosix 0],task.perform AdjustTimeZone here]

update msg model = match msg [
    (Tick newTime) -> { model.time = newTime; [model,browser.none] }
    (AdjustTimeZone newZone) -> { model.zone = newZone; [model,browser.none] }
]

subscriptions _ = every 1000 Tick

view model = h1 [] [
    text (to String (toHour model.zone model.time)
        ++ ":" ++ to String (toMinute model.zone model.time))
]

main = browser.element [init: init, update: update, subscriptions: subscriptions, view: view]
```

Commands and subscriptions are ordinary APN data (variants) that the page
interprets, so creating one does nothing; the page runs it after the update
that returned it, and each resulting message is another update.
`browser.none` and `browser.batch [...]` serve both, as Elm's `Cmd.none`,
`Cmd.batch`, `Sub.none` and `Sub.batch` do.

| Command | Message |
| --- | --- |
| `task.perform toMsg action` | `toMsg` of the action's result (a task is any action: `time.now`, `time.here`, `file.toUrl f`, `sequence [...]`) |
| `task.attempt toMsg action` | `toMsg (Ok result)`, or `toMsg (Err message)` when the action fails |
| `random.generate toMsg generator` | a value drawn from a fresh seed |
| `http.get [url: ..., expect: ...]` | `http.expectString toMsg` sends `toMsg (Ok body)`; `http.expectJson toMsg decoder` decodes the body |
| `file.selectFile mimes toMsg`, `file.selectFiles mimes toMsg` | the picked file, or the first and the rest |
| `browser.getViewport toMsg` | the window's size, a `browser.Viewport` (`[width: Number, height: Number]`) |

A failed request sends `Err` of `NetworkError`, `BadStatus status` or
`BadBody reason` (`http.HttpError`). Requests are subject to the page's CORS
rules.

| Subscription | Message |
| --- | --- |
| `every ms toMsg` (`time`) | the time, a `Posix`, every `ms` milliseconds |
| `browser.onAnimationFrame toMsg`, `browser.onAnimationFrameDelta toMsg` | each frame: the time, or the milliseconds since the last frame |
| `browser.onKeyDown toMsg`, `browser.onKeyUp toMsg` | the key's name (`"ArrowUp"`, `" "`) |
| `browser.onMouseMove`, `onMouseDown`, `onMouseUp`, `onMouseClick` | the page's x and y |
| `browser.onResize toMsg` | the window's width and height |
| `browser.onVisibilityChange toMsg` | `Visible` or `Hidden` |

A subscription is installed while `subscriptions model` asks for it, and is
given the newest message function after each update.

## HTML, SVG and events

HTML nodes and attributes are ordinary APN variants defined in `html`.
The host adapter interprets them using DOM APIs; text is rendered literally.
Import `html` explicitly. It exports `text` and `node tag attributes children`,
and elements by name (`div`, `span`, `p`, `h1`–`h4`, `button`, `input`,
`textarea`, `label`, `form`, `select`, `option`, `ul`, `ol`, `li`, `a`, `img`,
`pre`, `code`, `blockquote`, `cite`, `strong`, `em`, `br`, `hr`, `table`, `tr`,
`td`, `th`, `section`, `header`, `footer`, `nav`, `article`, `mainElement`).

Attributes include `attribute name value`, `style property value`, `className`,
`idAttribute`, `value`, `placeholder`, `typeAttribute`, `href`, `src`, `alt`,
`title`, `target`, `accept`, and the booleans `disabled`, `checked` and
`multiple`. Use strings for attribute values, or booleans for boolean HTML
attributes. Use `to String` before passing numbers to `text`.

`onClick message` and `onSubmit message` send a message (`onSubmit` prevents
the browser's form submission); `onInput toMessage` passes the field's string.
`onEvent name handler` (Elm's `on`) and `preventDefaultOn name handler` (which
also prevents the browser's default action, such as a drop opening the file)
pass the event as a record: `value` and `checked` (the target's), `key`,
`pageX`, `pageY`, and `files` (the target's or a drop's, each a `file.File`).

`svg = import "svg"` gives SVG elements and attributes, as Elm's `Svg` and
`Svg.Attributes` (`svg.svg`, `svg.circle`, `svg.rect`, `svg.line`, `svg.path`,
`svg.text_`, `svg.viewBox`, `svg.fill`, `svg.strokeWidth`, ...). An `svg`
element and everything inside it is SVG; attribute names keep their case.
Its names (`circle`, `image`) are also playground's, so it is usually imported
qualified.

`p5.canvas callbacks` is a [p5](p5.md) sketch inside a view: it keeps drawing
across renders with the newest callbacks, which may read the model.

Updates patch elements in place by position, preserving input focus and avoiding
unnecessary value resets. Runtime errors appear on the page; failed APN updates
or view evaluation retain the last successful model, and the error stays until
a later render succeeds (a sketch's error stays, as the sketch stops).

## Companion modules

These follow Elm's modules of the same names; the
[standard library](standard-library.md#browser-modules) lists them.

- `time`: a `Posix` (milliseconds since 1970, `millisToPosix`,
  `posixToMillis`) and a `Zone` (`utc`, the action `here`); `now` is an action;
  `toHour`, `toMinute`, `toSecond` and `toMillis zone time`.
- `random`: a `Generator` turns a seed into a value and
  the next seed. `random.int lo hi`, `random.float lo hi`, `random.uniform x
  xs`, `random.weighted [w,x] pairs`, `random.list n g`; generators are
  monads (`map`, `>>=`, `return`, `map2`, ...). `random.step generator seed`
  runs one without a page; `random.initialSeed n` makes a seed.
- `decode`: JSON decoders, as `Json.Decode` (open it, `import "decode"`, as Quotes
  does, unless the program also uses `random`, which shares `int`, `float` and `list`).
  `decode.decodeValue decoder value` is `Ok` or `Err`; `decode.string`,
  `decode.int`, `decode.float`, `decode.bool`, `decode.field name d`,
  `decode.at path d`, `decode.list d`, `decode.succeed x`; decoders are
  monads too (`map4 (a, b, c, d -> ...) d1 d2 d3 d4`).
- `file`: pickers (above) and `file.toUrl f`, the action yielding a file's URL.
  A file is a `file.File`: `[name: String, size: Int, mime: String, url: String]`.

Messages carry these types like any others, as Elm's do:
`Msg = | GotText (Result String http.HttpError)` (APN's `Result` holds its value
type first), `GotFiles file.File (List file.File)`, `GotViewport browser.Viewport`.

## Playground

`import "playground"` draws pictures, animations and games from shapes, as
[Elm's Playground](https://package.elm-lang.org/packages/evancz/elm-playground/latest/),
as SVG filling the window. The origin is the window's center, y grows upward,
and angles are degrees, counterclockwise:

```apn
import "playground"
main = picture [
    moveDown 80 $ rectangle brown 40 200
    moveUp 100 $ circle green 100
]
```

Shapes are `circle`, `oval`, `square`, `rectangle`, `triangle`, `pentagon`,
`hexagon`, `octagon`, `polygon color [[x,y],...]`, `image w h url`, `words
color text` and `group shapes`; `move`, `moveUp`/`Down`/`Left`/`Right`,
`moveX`, `moveY`, `rotate`, `scale` and `fade` place them. Colors are the
Tango palette (`red`, `lightBlue`, `darkCharcoal`, ...) or `rgb r g b`.
`picture shapes` never changes; `animation (time -> shapes)` is a view of the
time (milliseconds), with `spin`, `wave` and `zigzag`; `game view update
memory` calls `view computer memory` and `update computer memory` each frame,
where `computer` has `mouse` (`x`, `y`, `down`, `click`), `keyboard` (`up`,
`down`, `left`, `right`, `space`, `enter`, `shift`, `backspace`, `keys`, and
`toX`, `toY`, `toXY` of it), `screen` (`width`, `height`, `top`, `left`,
`right`, `bottom`) and `time`. Its names follow Elm's, so `words` draws text;
a program using both imports `text` qualified.

## Examples site and editor

```sh
apn --site examples/elm site
open site/index.html
```

`apn --site FOLDER OUTPUT` checks every `.apn` file in `FOLDER`, then writes
`OUTPUT/index.html`, the folder's `index.apn` (for `examples/elm`, the
examples page), and `OUTPUT/editor.html`, an editor holding the folder's other
programs, the standard library and the runtime. `editor.html#NAME` opens
`NAME.apn`; Run (Ctrl+Enter) runs the edited program in a sandboxed frame
beside it, checking it first. Edits are kept for the browser session; Reset
restores the example. The code is colored as in the REPL and Neovim; the
Dark/Light button switches between Catppuccin Frappé and Latte (the system's
choice until you pick one, then remembered). An example's first comment line
gives its title and,
when it names a URL, the Original link (`# Cube, from https://...`). Editor
programs may import the standard library, not other files.

## Limits

The `http` module's `fetch` also works in a browser as a synchronous request
(subject to CORS). Routing, keyed children, ports, and loading files the build
did not bundle are not implemented. Deno file, stdin, and process operations
are unavailable in the browser. Computation runs on the browser's main thread.
Embedded scripts, inline JavaScript event attributes, and executable URL
attributes (also SVG's `xlink:href`) are rejected.

For animated canvas sketches, use [p5](p5.md). p5 builds load a pinned
external p5.js script; HTML builds without sketches remain self-contained.
