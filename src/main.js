// Entry point. Kept separate from app.js so the application class can be
// imported by tests without a DOM being present at import time.

import { App } from "./app.js";

new App(document).start();
