#!/usr/bin/env node
// One-off: identify listings that existed earlier but the listings endpoint no longer
// returns. Reservations are fetched ACCOUNT-WIDE (not per listing), so bookings against
// removed listings still come back and reveal them.
const https=require('https');
const A=process.env.HOSTAWAY_ACCOUNT_ID,K=process.env.HOSTAWAY_API_KEY;
const SINCE=process.env.SINCE||'2026-09-01';
const req=(p,t)=>new Promise((res,rej)=>{const r=https.request({hostname:'api.hostaway.com',path:p,method:'GET',headers:{Authorization:`Bearer ${t}`},timeout:90000},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch{res(b)}})});r.on('timeout',()=>{r.destroy();rej(new Error('timeout'))});r.on('error',rej);r.end()});
const tok=()=>{const b=`grant_type=client_credentials&client_id=${A}&client_secret=${K}&scope=general`;return new Promise((res,rej)=>{const r=https.request({hostname:'api.hostaway.com',path:'/v1/accessTokens',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b)}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{const j=JSON.parse(d);j.access_token?res(j.access_token):rej(new Error(d))})});r.on('error',rej);r.write(b);r.end()})};
(async()=>{
  const t=await tok();
  let listings=[];
  for(let o=0;;o+=500){const r=await req(`/v1/listings?accountId=${A}&limit=500&offset=${o}`,t);const b=r?.result||[];listings=listings.concat(b);if(b.length<500)break;}
  console.log(`\nListings endpoint returns: ${listings.length}`);
  const l0=listings[0]||{};
  const statusKeys=Object.keys(l0).filter(k=>/status|active|archiv|visib|enabl/i.test(k));
  console.log(`status-like fields on a listing: ${statusKeys.join(', ')||'none'}`);
  for(const k of statusKeys){
    const dist={};listings.forEach(l=>{const v=String(l[k]);dist[v]=(dist[v]||0)+1});
    console.log(`   ${k}: ${JSON.stringify(dist)}`);
  }
  const known=new Map(listings.map(l=>[l.id,l.internalListingName]));

  console.log(`\nScanning account-wide reservations (departure from ${SINCE}) for unknown listings...`);
  const seen=new Map();let total=0;
  for(let o=0;;o+=500){
    const r=await req(`/v1/reservations?accountId=${A}&departureDateFrom=${SINCE}&limit=500&offset=${o}`,t);
    const b=r?.result||[];total+=b.length;
    for(const x of b){
      if(known.has(x.listingMapId))continue;
      if(!seen.has(x.listingMapId))seen.set(x.listingMapId,{id:x.listingMapId,name:x.listingName,n:0,last:''});
      const e=seen.get(x.listingMapId);e.n++;
      const d=String(x.departureDate).slice(0,10);if(d>e.last)e.last=d;
    }
    if(b.length<500)break;
  }
  console.log(`scanned ${total} reservations\n`);
  if(seen.size===0){console.log('No listings found in reservations that are absent from the listings endpoint.');}
  else{
    console.log(`Listings present in reservations but NOT returned by the listings endpoint (${seen.size}):`);
    [...seen.values()].sort((a,b)=>b.n-a.n).forEach(x=>
      console.log(`  ${String(x.id).padEnd(10)} ${String(x.name||'(no name)').padEnd(44)} ${String(x.n).padStart(5)} reservations, latest departure ${x.last}`));
  }
  console.log('');
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1)});
