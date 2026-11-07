import fs from "node:fs";
const out = [];
for (const f of ["src/styles.css","src/HubBar.css","src/ResponsiveSmallWindow.css"]) {
  fs.readFileSync(f,"utf8").split("\n").forEach((l,i)=>{
    const n=i+1, t=l.trim();
    if (/(box-shadow|text-shadow|drop-shadow)\s*:/.test(t) && !/:\s*none/.test(t) && !/transition/.test(t)) {
      let kind;
      if (/text-shadow/.test(t)) kind="text-glow";
      else if (/inset\s+-?\d+px\s+0\s+0\s+var/.test(t) || /inset 0 -?\d+px 0 var/.test(t)) kind="hard-inset-bar";
      else if (/rgba\(0, ?0, ?0/.test(t) && !/0 0 \d+px (var|#)/.test(t)) kind="blurred-drop";
      else kind="colour-glow";
      out.push([kind,f,n,t]);
    }
  });
}
const g={}; for(const o of out)(g[o[0]]??=[]).push(o);
for(const k in g){console.log("## "+k+" "+g[k].length);for(const o of g[k])console.log(`${o[1].replace("src/","")}:${o[2]}  ${o[3].slice(0,90)}`);}
