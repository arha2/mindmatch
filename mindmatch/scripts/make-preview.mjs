import fs from 'node:fs/promises';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/main.js'],bundle:true,write:false,format:'iife',minify:true,loader:{'.css':'empty'},define:{'import.meta.env.VITE_SUPABASE_URL':'""','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'""','import.meta.env.PROD':'false'}});
let html=await fs.readFile('index.html','utf8');
html=html.replace(/<link[^>]*>/g,'');
html=html.replace('</head>','<style>'+await fs.readFile('src/style.css','utf8')+'</style></head>');
html=html.replace(/<script[^>]*src="\/src\/main.js"[^>]*><\/script>/,'<script>'+result.outputFiles[0].text.replaceAll('</script>','<\\/script>')+'</script>');
await fs.writeFile('preview.html',html);
console.log('Created preview.html: self-contained demo; no backend or installation needed.');
