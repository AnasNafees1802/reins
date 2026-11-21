// Test fixture: page on :8701 with hard cases, cross-site iframe on 127.0.0.1:8702 (forces an out-of-process iframe).
const http = require('http');
const page = `<!doctype html><title>Reins Fixture</title>
<h1>Fixture</h1>
<p>Some intro text for reading.</p>
<input id=name placeholder="Your name">
<label>Email <input type=email id=email></label>
<input type=password value=secret aria-label=Password>
<select id=color><option>Red</option><option value=g>Green</option><option>Blue</option></select>
<label><input type=checkbox id=agree> I agree</label>
<div contenteditable=true id=editor style="border:1px solid;min-height:20px"></div>
<button id=go onclick="document.getElementById('out').textContent='clicked '+document.getElementById('name').value">Go</button>
<div style="cursor:pointer" onclick="this.textContent='card clicked'">A clickable card</div>
<p id=out></p>
<div style="position:relative"><button id=under onclick="out.textContent='under clicked'">Under</button>
<div id=cover style="position:absolute;inset:0;background:#fff8">overlay</div></div>
<button onclick="alert('hello alert');out.textContent='after alert'">Alert me</button>
<a href="/two" target=_blank>Open new tab</a>
<input type=file id=file style="display:none" onchange="out.textContent='file: '+this.files[0].name">
<button onclick="file.click()">Upload</button>
<my-comp></my-comp>
<div style="height:1500px"></div>
<button onclick="out.textContent='bottom clicked'">Bottom button</button>
<iframe src="http://127.0.0.1:8702/frame" width=400 height=120></iframe>
<script>
customElements.define('my-comp', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<button onclick="this.textContent=\\'shadow ok\\'">Shadow button</button>'; } });
</script>`;
const frame = `<!doctype html><body><input id=fi placeholder="In frame"><button onclick="document.body.append(' frame clicked: '+fi.value)">Frame button</button></body>`;
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url === '/two' ? '<title>Two</title><h1>Second page</h1>' : page); }).listen(8701);
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(frame); }).listen(8702);
console.log('fixture on 8701/8702');
