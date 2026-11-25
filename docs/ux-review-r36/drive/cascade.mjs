import { createRequire } from "node:module";
const require = createRequire("/tmp/pwtool/");
const { chromium } = require("playwright-core");
const [port,w,h]=process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/usr/bin/chromium-browser", args: ["--no-sandbox"] });
const page = await (await b.newContext({ viewport:{width:+w,height:+h} })).newPage();
await page.addInitScript(`localStorage.setItem("vs.vibePicked","1")`);
await page.goto(`http://127.0.0.1:${port}/?demo=1&riff=1`);
await page.waitForSelector('[data-testid="boring-needs-you-item"]');
console.log(JSON.stringify(await page.evaluate(()=>{
 const pick=(el,ps)=>Object.fromEntries(ps.map(p=>[p,getComputedStyle(el).getPropertyValue(p)]));
 const ps=["flex-grow","flex-shrink","flex-basis","min-width","max-width","overflow","text-overflow","white-space","display","text-indent"];
 const rows=[...document.querySelectorAll('[data-testid="boring-needs-you-item"]')];
 const lead=rows.find(r=>r.querySelector('.boring-needs-lane')?.textContent==="Main Game");
 const desk=rows.find(r=>r.querySelector('.boring-needs-lane')?.textContent==="")||null;
 return {sidebarW:document.querySelector('.boring-sidebar').getBoundingClientRect().width,
  lane:pick(lead.querySelector('.boring-needs-lane'),ps), proj:pick(lead.querySelector('.boring-needs-proj'),ps),
  where:pick(lead.querySelector('[data-testid="boring-needs-where"]'),["display","flex-basis","max-width","overflow"]),
  sepLead:getComputedStyle(lead.querySelector('.boring-needs-proj'),'::before').content,
  emptyLaneRows:rows.filter(r=>r.querySelector('.boring-needs-lane')?.textContent==="").length,
  sepEmpty: desk?getComputedStyle(desk.querySelector('.boring-needs-proj'),'::before').content:null };
})));
await b.close();
