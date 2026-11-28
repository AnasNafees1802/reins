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
<ul><li><a href="#prime"><input type=checkbox><span>Prime delivery</span></a></li><li><a href="#4star"><input type=checkbox><span>4 stars and up</span></a></li></ul>
<span class=btn><input type=submit aria-labelledby=atc><span id=atc>Add to cart</span></span>
<div style="height:1500px"></div>
<button onclick="out.textContent='bottom clicked'">Bottom button</button>
<iframe src="http://127.0.0.1:8702/frame" width=400 height=120></iframe>
<script>
customElements.define('my-comp', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<button onclick="this.textContent=\\'shadow ok\\'">Shadow button</button>'; } });
</script>`;
const frame = `<!doctype html><body><input id=fi placeholder="In frame"><button onclick="document.body.append(' frame clicked: '+fi.value)">Frame button</button></body>`;
// /app: an SPA that calls its own API with a bearer token and logs a console error (network + console tests).
const app = `<!doctype html><title>App</title><h1>App</h1><ul id=list><li>Item one, 1 minute ago</li></ul><script>
console.error('boom from app');
fetch('/api/items?page=1', { headers: { authorization: 'Bearer sekret-token', 'x-fetch-nonce': 'nonce-sekret' } }).then(r => r.json()).then(j => document.title = 'App ' + j.items.length);
fetch('/api/missing');
fetch('http://localhost:8702/api/public', { method: 'POST', body: 'q=one' });
</script>`;
// /hard: the cases that cost agents extra turns. A debounced search that fills in after a slow API call, a list
// that re-renders (stale refs), a custom dropdown, a confirm dialog before a slow save, and a clock that never stops
// mutating the DOM (like ads, carousels and live counters do).
const hard = `<!doctype html><title>Hard</title><h1>Hard</h1>
<p>Server time <span id=clock>0</span></p>
<input id=q aria-label="Search fruit">
<ul id=results></ul>
<button id=refresh>Refresh list</button>
<p id=picked>Picked: none</p>
<div role=combobox id=ship aria-expanded=false tabindex=0>Shipping: Standard</div>
<div role=listbox id=opts hidden><div role=option>Standard</div><div role=option>Express</div><div role=option>Overnight</div></div>
<button id=save>Save</button>
<div id=modal hidden role=dialog aria-modal=true aria-label="Confirm save"><p>Save changes?</p><button id=okbtn>Confirm</button></div>
<p id=msg></p>
<script>
if (!location.search.includes('calm')) setInterval(() => clock.textContent = Date.now() % 100000, 100);
let list = [], t;
const render = () => results.replaceChildren(...list.map(f => { const li = document.createElement('li'), b = li.appendChild(document.createElement('button')); b.className = 'pick'; b.textContent = f; return li; }));
q.oninput = () => { clearTimeout(t); t = setTimeout(async () => { list = await (await fetch('/api/search?q=' + encodeURIComponent(q.value))).json(); render(); }, 300); };
results.onclick = e => { if (e.target.matches('.pick')) picked.textContent = 'Picked: ' + e.target.textContent; };
refresh.onclick = render;
ship.onclick = () => { opts.hidden = !opts.hidden; ship.setAttribute('aria-expanded', !opts.hidden); };
opts.onclick = e => { if (e.target.matches('[role=option]')) { ship.textContent = 'Shipping: ' + e.target.textContent; opts.hidden = true; ship.setAttribute('aria-expanded', false); } };
save.onclick = () => modal.hidden = false;
okbtn.onclick = async () => { modal.hidden = true; msg.textContent = 'Saving'; const r = await (await fetch('/api/save', { method: 'POST', body: ship.textContent })).text(); msg.textContent = 'Saved: ' + r; };
</script>`;
// /forms: the Naukri-style cases from a real form-filling session. A skills box whose maxlength shrinks, a radio whose
// input sits under a decorative circle, a modal that Escape removes, a year picker whose options are a portal list
// that scrolls inside itself, and a script tag that the page renders as text.
const forms = `<!doctype html><title>Forms</title><h1>Forms</h1>
<button onclick="out.textContent='background clicked'">Background action</button>
<p id=out></p>
<input aria-label="Skills" maxlength=6>
<input aria-label="Salary" oninput="const d=this.value.replace(/\\D/g,'');this.value=d?(+d).toLocaleString('en-IN'):''">
<label><input type=checkbox id=remote style="position:absolute;opacity:0"><span style="display:inline-block;width:14px;height:14px;border:1px solid"></span> Remote only</label>
<script style="display:block;font-size:1px">var leaked = 42;</script>
<button id=open onclick="dlg.hidden=false">Edit education</button>
<div id=dlg hidden role=dialog aria-modal=true aria-label="Education">
  <input aria-label="Course" value="MCA">
  <div style="position:relative;height:20px"><input type=radio name=mode id=r1 checked><label for=r1>Full time</label></div>
  <div style="position:relative;height:20px"><input type=radio name=mode id=r2 style="position:absolute;left:0;top:0;margin:0;opacity:0"><span style="position:absolute;left:0;top:0;width:16px;height:16px;border:1px solid;border-radius:50%;background:#fff"></span><label for=r2 style="margin-left:22px">Distance</label></div>
  <input id=yr aria-label="Ending year" readonly value="2024">
</div>
<div style="height:1200px"></div>
<script>
addEventListener('keydown', e => { if (e.key === 'Escape') dlg.remove(); });
yr.onclick = () => {
  document.getElementById('yrs')?.remove();
  const r = yr.getBoundingClientRect(), ul = document.createElement('ul');
  ul.id = 'yrs';
  ul.style = 'position:fixed;margin:0;padding:0;list-style:none;background:#fff;border:1px solid;overflow:auto;height:60px;width:120px;left:' + (r.right + 20) + 'px;top:40px';
  for (let y = 2033; y >= 2000; y--) ul.insertAdjacentHTML('beforeend', '<li><a href="javascript:void 0">' + y + '</a></li>');
  ul.onclick = e => { if (e.target.localName === 'a') { yr.value = e.target.textContent; ul.remove(); } };
  document.body.append(ul);
};
</script>`;
// /hung: a cross-site iframe that locks up its own process, so evaluating in it never returns.
const hung = `<!doctype html><title>Hung</title><h1>Hung frame page</h1><button>Still works</button><iframe src="http://127.0.0.1:8702/busy"></iframe>`;
const FRUIT = ['Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Grape', 'Mango', 'Papaya'];
const delay = ms => new Promise(r => setTimeout(r, ms));
http.createServer(async (q, r) => {
  if (q.url.startsWith('/api/search')) {
    await delay(700);
    const s = new URL(q.url, 'http://x').searchParams.get('q').toLowerCase();
    r.setHeader('content-type', 'application/json');
    return r.end(JSON.stringify(FRUIT.filter(f => f.toLowerCase().startsWith(s))));
  }
  if (q.url === '/api/save') {
    let body = '';
    for await (const c of q) body += c;
    await delay(600);
    return r.end(body.replace('Shipping: ', ''));
  }
  if (q.url.startsWith('/api/items')) {
    r.setHeader('content-type', 'application/json');
    if (q.headers.authorization !== 'Bearer sekret-token') { r.statusCode = 401; return r.end('{"error":"no auth"}'); }
    return r.end(JSON.stringify({ page: new URL(q.url, 'http://x').searchParams.get('page'), items: ['a', 'b'] }));
  }
  if (q.url === '/api/missing') { r.statusCode = 404; return r.end('nope'); }
  r.setHeader('content-type', 'text/html');
  r.end(q.url === '/two' ? '<title>Two</title><h1>Second page</h1>' : q.url === '/app' ? app : q.url.startsWith('/hard') ? hard : q.url === '/forms' ? forms : q.url === '/hung' ? hung : page);
}).listen(8701);
http.createServer(async (q, r) => {
  // a public cross-origin API: ACAO "*" means the browser blocks the response if credentials were included
  if (q.url === '/api/public') {
    let body = '';
    for await (const c of q) body += c;
    r.setHeader('access-control-allow-origin', '*');
    r.setHeader('content-type', 'application/json');
    return r.end(JSON.stringify({ echo: body }));
  }
  r.setHeader('content-type', 'text/html');
  r.end(q.url === '/busy' ? '<body>busy<script>setTimeout(() => { for (;;); }, 300)</script>' : frame);
}).listen(8702);
console.log('fixture on 8701/8702');
