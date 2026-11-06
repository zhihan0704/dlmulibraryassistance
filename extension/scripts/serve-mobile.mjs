import http from 'node:http';import {readFile,stat} from 'node:fs/promises';import {resolve,extname,sep} from 'node:path';
const root=resolve('mobile-dist'),port=Number(process.env.PORT??4173);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT 必须为1024–65535');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webmanifest':'application/manifest+json'};
http.createServer(async(req,res)=>{try{
  if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405).end();return}
  const url=new URL(req.url??'/','http://localhost');const name=decodeURIComponent(url.pathname);const file=resolve(root,'.'+(name.endsWith('/')?name+'index.html':name));
  if(!file.startsWith(root+sep)||(await stat(file)).isDirectory()){res.writeHead(404).end();return}
  res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
  const body=await readFile(file);res.end(req.method==='HEAD'?undefined:body);
}catch{res.writeHead(404).end()}}).listen(port,'127.0.0.1',()=>console.log(`本机验证：http://localhost:${port}/\n手机安装请将mobile-dist部署到你控制的HTTPS静态站点。此服务器仅监听本机，不暴露私人数据。`));
