const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=__dirname,workspace=path.resolve(root,'../../..');
const modules=fs.existsSync(path.join(root,'node_modules/three'))?path.join(root,'node_modules'):path.join(workspace,'apps/desktop-client/node_modules');
const esbuild=require(path.join(modules,'esbuild'));
const artwork=Object.fromEntries(fs.readdirSync(path.join(root,'assets')).map(name=>
  [name,'data:image/png;base64,'+fs.readFileSync(path.join(root,'assets',name)).toString('base64')]));
const output=esbuild.buildSync({entryPoints:[path.join(root,'source/renderer.js')],bundle:true,minify:true,
  format:'iife',target:['es2022'],nodePaths:[modules],write:false,legalComments:'eof'}).outputFiles[0].text;
const destinations=[path.join(root,'../ios/Astella/LaunchMotion'),path.join(root,'../android/app/src/main/assets/launch-motion')];
const manifest={};
for(const name of fs.readdirSync(path.join(root,'assets'))) {
  manifest[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'assets',name))).digest('hex');
}
for(const destination of destinations) {
  fs.mkdirSync(destination,{recursive:true});
  fs.rmSync(path.join(destination,'assets'),{recursive:true,force:true});
  fs.mkdirSync(path.join(destination,'artwork'),{recursive:true});
  for (const [name,uri] of Object.entries(artwork)) {
    fs.writeFileSync(path.join(destination,'artwork',name+'.js'),
      'window.AstellaArtwork??={};window.AstellaArtwork['+JSON.stringify(name)+']='+JSON.stringify(uri)+';');
  }
  fs.copyFileSync(path.join(root,'index.template.html'),path.join(destination,'index.html'));
  fs.copyFileSync(path.join(modules,'three/LICENSE'),path.join(destination,'THREE-LICENSE.txt'));
  fs.writeFileSync(path.join(destination,'motion.js'),output);
  fs.writeFileSync(path.join(destination,'artwork-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
}
for (const [name,file] of [['LaunchDay','soft-star-approved.png'],['LaunchNight','night-room-approved.png']]) {
  const ios=path.join(root,'../ios/Astella/Assets.xcassets',name+'.imageset');
  fs.mkdirSync(ios,{recursive:true});
  fs.copyFileSync(path.join(root,'assets',file),path.join(ios,'artwork.png'));
  fs.writeFileSync(path.join(ios,'Contents.json'),JSON.stringify({images:[{idiom:'universal',filename:'artwork.png'}],info:{version:1,author:'xcode'}},null,2));
  fs.copyFileSync(path.join(root,'assets',file),path.join(root,'../android/app/src/main/res/drawable-nodpi',name==='LaunchDay'?'launch_day.png':'launch_night.png'));
}
fs.copyFileSync(path.join(root,'assets/companion-stage.png'),
  path.join(root,'../ios/Astella/Assets.xcassets/CompanionStage.imageset/companion-stage.png'));
fs.copyFileSync(path.join(root,'assets/companion-stage.png'),
  path.join(root,'../android/app/src/main/res/drawable-nodpi/companion_stage.png'));
console.log('Built offline launch motion for iOS and Android.');
