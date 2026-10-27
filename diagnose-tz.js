// Determines the timezone of the reservation creation timestamps by comparing the
// newest records against the clock at run time. Getting this wrong shifts the
// 6PM IST pickup cutoff by 5.5 hours.
const https=require('https');
const A=process.env.HOSTAWAY_ACCOUNT_ID,K=process.env.HOSTAWAY_API_KEY;
const req=(p,t)=>new Promise((res,rej)=>{const r=https.request({hostname:'api.hostaway.com',path:p,method:'GET',headers:{Authorization:`Bearer ${t}`},timeout:60000},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch{res(b)}})});r.on('error',rej);r.end()});
const tok=()=>{const b=`grant_type=client_credentials&client_id=${A}&client_secret=${K}&scope=general`;return new Promise((res,rej)=>{const r=https.request({hostname:'api.hostaway.com',path:'/v1/accessTokens',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b)}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{const j=JSON.parse(d);j.access_token?res(j.access_token):rej(new Error(d))})});r.on('error',rej);r.write(b);r.end()})};
(async()=>{
  const t=await tok();
  const now=new Date();
  const utc=now.toISOString().replace('T',' ').slice(0,19);
  const ist=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:'Asia/Kolkata'}).format(now).replace(',','');
  console.log(`\nclock at run:  UTC = ${utc}`);
  console.log(`               IST = ${ist}\n`);
  const r=await req(`/v1/reservations?accountId=${A}&limit=15&sortOrder=insertedOnDesc`,t);
  const rows=(r?.result||[]);
  console.log(`${rows.length} rows (sortOrder=insertedOnDesc):`);
  console.log('  '+'reservationDate'.padEnd(22)+'insertedOn'.padEnd(22)+'latestActivityOn');
  rows.slice(0,10).forEach(x=>console.log('  '+String(x.reservationDate).padEnd(22)+String(x.insertedOn).padEnd(22)+String(x.latestActivityOn)));
  const max=rows.map(x=>x.insertedOn).filter(Boolean).sort().pop();
  if(max){
    const dUTC=(now-new Date(max.replace(' ','T')+'Z'))/60000;
    console.log(`\nnewest insertedOn = ${max}`);
    console.log(`  minutes behind UTC now : ${dUTC.toFixed(1)}`);
    console.log(`  minutes behind IST now : ${(dUTC-330).toFixed(1)}`);
    console.log(`\n=> ${Math.abs(dUTC)<Math.abs(dUTC-330)?'UTC':'IST'} (whichever gap is nearer zero / non-negative)`);
  }
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1)});
