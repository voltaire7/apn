# Numeric arrays and record vectors

Arithmetic `+`, `-`, `*`, `/`, `%`, and `^` operates elementwise on lists and
records. Unary `-` negates every numeric leaf. Concatenation remains `++`.

```apn
[1,2,3] + [10,20,30]   # [11,22,33]
[1,2,3] * 2              # [2,4,6]
10 - [1,2,3]             # [9,8,7]
[1,2,3] / 2              # [1/2,1,3/2]
2 ^ [1,2,3]              # [2,4,8]
[[1,2],[3,4]] * 2       # [[2,4],[6,8]]
[x = 1, y = 2] + [y = 20, x = 10] # [x = 11, y = 22]
```

Two collections must have matching structure: lists pair by position and require
equal lengths, records require exactly the same key strings and pair by key.
Result records preserve the left operand's field order. Nested structures are
processed recursively. A number on either side broadcasts through the entire
other collection, preserving operand order for subtraction, division and powers.
There is no automatic row/column or singleton-axis broadcasting:
`[[1,2],[3,4]] + [10,20]` is a shape error. Matching ragged structures can be
operated on elementwise, but rectangular matrix helpers reject ragged matrices.

Leaves must be numbers. Numeric type promotion, exact fractions, complex values,
overflow checks and division-by-zero behavior are the same as scalar arithmetic.
A String is a list of Chars, which are numbers, so `+` on one adds item by
item (`"ab" + 1` is `['b','c']`); `++` joins text. Record type placeholders must be initialized before arithmetic demands
them. Lists and records cannot be implicitly mixed.

Results are lazy. Shape and leaf errors appear when the relevant portion is
consumed. `head ([1] + [2,3])` returns `3`, but consuming the whole result errors.
Infinite lists work with finite consumers, e.g. `take 3 ([0..] + [10..])`.
Elements are shared after evaluation, just like other lazy list elements.

`xs * function` and `function * xs` iterate with the same behavior; `xs * ys` multiplies
numeric collections elementwise. Iteration is eager for lists, so use `map`
for lazy or infinite inputs. Records supply `[key,value]` entries, and integer
counts supply indexes starting at zero. Equality remains structural, and comparisons
do not automatically produce masks. Use `map` for predicates and `filter` for
selection. Matrix multiplication is explicit via `matmul`.

## APN-defined helpers

`std.array` provides:

| Function | Meaning |
| --- | --- |
| `dot xs ys` | Sum of elementwise products; numeric vectors must have equal length |
| `transpose rows` | Exchange rows and columns, rejecting unequal row lengths |
| `matmul left right` | Matrix multiplication; rectangular matrices with matching inner dimensions |
| `shape array` | Dimensions of a finite rectangular numeric list; a number has shape `[]`, an empty list `[0]` |

These helpers are written in `lib/std/array.apn`. `shape` traverses the input;
`matmul` checks finite row lengths up front and computes result entries lazily.
`transpose` needs a finite number of rows and checks lengths as it produces
columns. `dot` needs finite vectors to return a sum. An empty outer matrix is
interpreted as 0-by-0; `matmul [[]] []` yields `[[]]`.

```apn
std <- import "std"
[..] = std.array
dot [1,2,3] [4,5,6]                # 32
transpose [[1,2,3],[4,5,6]]       # [[1,4],[2,5],[3,6]]
matmul [[1,2],[3,4]] [[5,6],[7,8]]  # [[19,22],[43,50]]
shape [[1,2],[3,4]]                 # [2,2]
```
