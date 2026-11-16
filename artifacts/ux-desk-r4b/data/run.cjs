const j=JSON.parse(require("fs").readFileSync(process.argv[2]));const a=Array.isArray(j)?j:(j.agents||j.items||[]);const now=Date.now();
const run=a.filter(x=>x.status==="running"&&!x.archivedAt);
console.log("total",a.length,"running",run.length);
for(const x of run){const q=Math.round((now-Date.parse(x.updatedAt))/60000);console.log(q+"m quiet","tool=",x.openToolSince===undefined?"UNDEF":x.openToolSince===null?"null":(x.openToolName+" "+Math.round((now-x.openToolSince)/60000)+"m"),"to=",x.openToolTimeoutMs,"perm=",(x.pendingPermissions||[]).length,x.id.slice(0,8),(x.title||"").slice(0,50))}
