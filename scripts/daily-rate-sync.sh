#!/bin/bash
JWT="$(node -e "
const crypto=require('crypto');
const fs=require('fs');
const env=fs.readFileSync('/opt/sanlyn-api-test/.env','utf8').split('\n').reduce((a,l)=>{const[k,...v]=l.split('=');if(k)a[k.trim()]=v.join('=').trim();return a;},{});
const secret=env.JWT_SECRET||'';
const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const p=Buffer.from(JSON.stringify({account:'cron-sync',role:'internal',iat:Math.floor(Date.now()/1000)})).toString('base64url');
const sig=crypto.createHmac('sha256',secret).update(h+'.'+p).digest('base64url');
console.log(h+'.'+p+'.'+sig);
" 2>/dev/null)"
curl -s 'https://ai.sanlyn.cn/api/db/exchange-rate?pair=USD_CNY'   -H "Authorization: Bearer $JWT"   -H 'Content-Type: application/json'   >> /var/log/sanlyn-rate-sync.log 2>&1
echo "[$(date)] rate sync done" >> /var/log/sanlyn-rate-sync.log
