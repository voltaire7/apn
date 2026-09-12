# Spinning ASCII donut

From the repository root:

```sh
apn examples/graphics/run-donut.apn
```

Stop with Ctrl+C. Use a terminal at least 80 columns by 41 rows; the extra row
avoids scrolling after the final newline. The animation clears the screen once
and returns the cursor home for each frame. It does not hide the cursor or
change terminal modes.

```sh
apn examples/graphics/run-donut.apn 10        # stop after ten frames
apn examples/graphics/run-donut.apn -1 dense # original C sampling density
```

The geometry, rotations, perspective, luminance ramp, and z-buffer are written
in `examples/graphics/donut.apn`. Radius values are 1 and 2, camera distance is 5,
angles advance by .04 and .02 per frame, and the loop sleeps 16 milliseconds
after rendering. The default samples at .21 and .06 radians to reduce interpreter
work; `dense` uses the supplied C version's .07 and .02. Rendering time is added
to the delay, so this interpreter version is substantially slower than C.

Surface positions and normals are precomputed. Each frame uses arrays of
`Mutable` depth and character cells to keep the nearest lit surface at each
pixel. The renderer returns 40 rows of 80 characters, each ending in a newline.

The helper can be loaded without starting the animation:

```apn
load "examples/graphics/donut"
[samples] = [makeDonutSamples .21 .06]
print (renderDonut samples .9 .4 80 40)
```

`std/system` provides `sleep milliseconds`, which requires a nonnegative integer
and remains interruptible. Strings and character literals accept `\e` for ASCII
ESC, e.g. `emit "\e[H"`. Sleep is a synchronous terminal primitive, not a browser
timer.
