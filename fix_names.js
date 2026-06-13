const fs = require('fs');
let badCode = fs.readFileSync('src/renderer.ts', 'utf8');

// The one I added
badCode = badCode.replace(/^function \((filename\) \{\s+const lbl = \$\('tl-audio-label'\);)/m, 'function updateAudioUI$1');

// Get original functions
let origCode = fs.readFileSync('../Yunus Animate/renderer.js', 'utf8');
let origFuncs = [...origCode.matchAll(/^function\s+([a-zA-Z0-9_]+)\((.*?)\)\s*\{([\s\S]{10,50}?)\n/gm)];

let replacedCount = 0;
for (let match of origFuncs) {
  let name = match[1];
  let params = match[2];
  let bodyStart = match[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex
  
  let badRegex = new RegExp('^function \\(' + params.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)\\s*\\{\\s*' + bodyStart, 'm');
  
  if (badCode.match(badRegex)) {
    badCode = badCode.replace(badRegex, 'function ' + name + '(' + params + ') {' + match[3]);
    replacedCount++;
  } else {
    // try looser match
    let looserBody = match[3].trim().substring(0, 15).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let looseRegex = new RegExp('^function \\(.*?\\)\\s*\\{\\s*' + looserBody, 'm');
    let m = badCode.match(looseRegex);
    if (m) {
      badCode = badCode.replace(looseRegex, 'function ' + name + m[0].substring(8));
      replacedCount++;
    } else {
        console.log("Could not find:", name);
    }
  }
}

console.log('Replaced:', replacedCount);
fs.writeFileSync('src/renderer.ts', badCode);
