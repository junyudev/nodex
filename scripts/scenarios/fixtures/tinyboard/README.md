# Tinyboard

A small task list for keeping a release moving. Tasks can be marked complete
and restored without losing their place.

Serve this directory with a static web server and open `index.html` in a browser.
The application uses browser modules and has no dependencies or build step.

The task model lives in `src/tasks.js`; `src/main.js` renders the list and handles
task updates. Task changes last until the page reloads.
