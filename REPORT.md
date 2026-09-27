# ship todo verification

## node --check

Command:

```sh
node --check api/db/hr-ship-todo.mjs && node --check api/db/hr-ship-todo.test.mjs && node --check routes-pet-hr.mjs && node --check _staff/staff-agenda.js && node --check _staff/staff-app.js
```

Output: no output, exit 0.

## fake pool tests

Command:

```sh
node api/db/hr-ship-todo.test.mjs
```

Output:

```text
hr-ship-todo tests passed
```

## git diff --stat

Main worktree:

```text
 api/db/hr-ship-todo.mjs      | 201 +++++++++++++++++++++++++++++++++++++++++++
 api/db/hr-ship-todo.test.mjs | 120 ++++++++++++++++++++++++++
 routes-pet-hr.mjs            |   1 +
 3 files changed, 322 insertions(+)
```

Staff worktree:

```text
 staff-agenda.js | 26 ++++++++++++++++++++++++++
 staff-app.css   |  1 +
 staff-app.html  |  1 +
 staff-app.js    | 31 ++-----------------------------
 4 files changed, 30 insertions(+), 29 deletions(-)
```
