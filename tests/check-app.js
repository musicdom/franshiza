const fs = require("fs");
const vm = require("vm");
const html = fs.readFileSync("index.html", "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error("Inline application script was not found");
new vm.Script(match[1], { filename: "index.html" });

const ids = [...html.matchAll(new RegExp('\\bid="([^"]+)"', "g"))].map(match => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) throw new Error("Duplicate DOM ids: " + [...new Set(duplicateIds)].join(", "));
const references = [...match[1].matchAll(new RegExp('\\$\\("([^"]+)"\\)', "g"))].map(match => match[1]);
const missing = [...new Set(references.filter(id => !ids.includes(id)))];
if (missing.length) throw new Error("Missing DOM ids: " + missing.join(", "));
const buttons = [...html.matchAll(new RegExp('<button\\b[^>]*\\bid="([^"]+)"', "g"))].map(match => match[1]);
const unbound = buttons.filter(id => !match[1].includes('$("' + id + '").onclick') && !match[1].includes('$("' + id + '").oninput'));
if (unbound.length) throw new Error("Buttons without handlers: " + unbound.join(", "));

process.stdout.write("Norka browser script, DOM references and button bindings: OK\n");
