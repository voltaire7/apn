# Browser HTML

Build a standalone browser app (Deno with `deno bundle` support required):

```sh
apn --html examples/browser/counter.apn counter.html
open counter.html
```

`apn examples/browser/counter.apn` only evaluates its definitions and exits.
The `--html` command embeds the APN interpreter, source, and standard modules
into one HTML file. Open that file in a browser; no server or runtime download
is required. Rebuild and refresh after editing the APN source.

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
    div [] [text (toString model)]
    button [onClick Increment] [text "+"]
]

main = browser.sandbox [init: 0, update: update, view: view]
```

`init` is the initial model. A click sends its message to `update msg model`;
the resulting model is passed to `view`. Multiline lists need no commas.
Inside an enclosing parenthesized expression, existing APN layout rules suppress
newlines; use commas there or bind the view separately, as above.
HTML nodes and attributes are ordinary APN variants defined in `html`.
The host adapter interprets them using DOM APIs; text is rendered literally.

Import `html` explicitly. It exports `text`, `node tag attributes children`,
`div`, `span`, `p`, `h1`, `h2`, `button`, `input`, `textarea`, `label`, `form`,
`ul`, `li`, `a`, `section`, and `mainElement`.

Attributes include `attribute name value`, `style property value`, `className`,
`idAttribute`, `value`, `placeholder`, `typeAttribute`, `href`, and `disabled`.
Use strings for attribute values, or booleans for boolean HTML attributes.
Use `toString` before passing numbers to `text`.

Events are `onClick message`, `onInput toMessage`, and `onSubmit message`.
`onInput` passes the field's current string to its function or constructor;
`onSubmit` prevents the browser's default form submission.
See `examples/browser/greeting.apn` for a controlled input and clear button:

```sh
apn --html examples/browser/greeting.apn greeting.html
open greeting.html
```

Updates patch elements in place by position, preserving input focus and avoiding
unnecessary value resets. Runtime errors appear on the page. Failed APN updates
or view evaluation retain the last successful model.

This first API supports synchronous sandbox apps. Commands, subscriptions,
HTTP effects, routing, keyed children, SVG, and arbitrary local file loading
are not implemented. Deno file, stdin, and process operations are unavailable
in the browser. Computation runs on the browser's main thread. Embedded scripts,
inline JavaScript event attributes, and executable URL attributes are rejected.

The design follows Elm's [buttons example](https://guide.elm-lang.org/architecture/buttons.html)
while retaining APN notation and its existing interpreter.

For animated canvas sketches, use [p5](p5.md). p5 builds load a pinned
external p5.js script; HTML sandbox builds remain self-contained.
