import {actorUniforms,actorVertex,actorFragment} from './actor-rig.js';
// All color and perspective come from the approved artwork.
export const vertex=`
varying vec2 vUv;uniform sampler2D uOuter;uniform vec2 uSize;
uniform float uTime,uFlow,uCompare,uScene,uJelly,uLoading,uKick,uExit;
${actorUniforms}
${actorVertex}
float jellyResponse(float time,float loading){float pressDuration=mix(.40,.27,loading);float strength=mix(.12,.065,loading);if(time<pressDuration){float x=clamp(time/pressDuration,0.,1.);return -strength*x*x*(3.-2.*x);}float release=time-pressDuration;return -strength*cos(release*8.8)*exp(-release*2.65);}
void main(){
 vUv=uv;vec3 p=position;vec2 pixel=vec2(uv.x*uSize.x,(1.-uv.y)*uSize.y);
 vec2 q=(pixel-vec2(428.,837.))/vec2(390.,465.);
 if(uScene<.5){
  float shell=texture2D(uOuter,uv).a*smoothstep(.73,.91,length(q));
  float wave=sin(dot(pixel,vec2(.040,.027))-uTime*1.85)*.65+sin(dot(pixel,vec2(-.024,.034))-uTime*1.23)*.35;
  float amount=uFlow*(1.-uCompare)*shell*3.5;
  p.xy+=vec2(q.x,-q.y)/max(.2,length(q))*wave*amount;
 }else{
  // A delayed spring at each lobe conserves volume while the lower star stays seated.
  vec2 relative=pixel-vec2(426.,1090.);
  float theta=atan(relative.y,relative.x);
  float delay=.075*(.5+.5*sin(theta*2.-.5));
  float cycle=uLoading>.5?mod(uTime,5.2):uTime;
  float localTime=max(0.,cycle-delay);
  float response=jellyResponse(localTime,uLoading);
  float kickTime=max(0.,uKick-delay);
  float kick=uKick>=0.?-.065*sin(kickTime*9.)*exp(-kickTime*2.9):0.;
  response+=kick;
  float head=1.-smoothstep(.88,1.16,length((pixel-vec2(431.,1023.))/vec2(242.,236.)));
  float tail=1.-smoothstep(.88,1.18,length((pixel-vec2(648.,1098.))/vec2(132.,154.)));
  float desk=smoothstep(1100.,1140.,pixel.y)*(1.-smoothstep(1355.,1400.,pixel.y))*(1.-smoothstep(260.,365.,abs(pixel.x-383.)));
  float protectedArea=max(head,max(tail,desk));
  float zone=smoothstep(285.,410.,pixel.y)*(1.-smoothstep(1190.,1370.,pixel.y));
  zone*=1.-smoothstep(1.04,1.25,length((pixel-vec2(426.,800.))/vec2(435.,480.)));
  float strength=zone*(1.-protectedArea)*uJelly*(1.-uExit);
  vec2 displacement=vec2(relative.x*(-response*.18),-relative.y*response);
  float release=max(0.,localTime-mix(.4,.27,uLoading));
  float wobble=sin(release*8.8-theta*1.4)*exp(-release*2.5)*smoothstep(0.,.2,release);
  displacement+=vec2(cos(theta)*wobble*9.,sin(theta*2.)*wobble*13.);
  p.xy+=displacement*strength;
 }
 p.xy+=companionDisplacement(pixel);
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
}`;

export const fragment=`
varying vec2 vUv;
uniform sampler2D uArt,uOuter,uInterior,uClean,uActorMask;
uniform vec2 uSize;
uniform float uLamp,uTime,uFlow,uCompare,uScene,uExit,uJelly,uLoading,uKick,uRemoveActor;
${actorUniforms}
${actorFragment}

// Two crossing wave trains and a propagating radial wave provide continuous water motion.
// The first two components are the surface gradient; the third is the wave height.
vec3 water(vec2 p){
 vec2 d0=vec2(.83205,.55470),d1=vec2(-.57668,.81697);
 vec2 origin=p-vec2(155.,1080.);vec2 radial=origin/max(length(origin),1.);
 float a=dot(p,d0)*.048-uTime*1.85;
 float b=dot(p,d1)*.0416-uTime*1.23;
 float c=length(origin)*.062-uTime*2.25;
 vec2 gradient=.70*cos(a)*d0+.42*cos(b)*d1+.30*cos(c)*radial;
 return vec3(gradient,.60*sin(a)+.30*sin(b)+.18*sin(c));
}

vec4 artwork(vec2 uv){
 vec4 source=texture2D(uArt,uv);
 if(uRemoveActor>0.){
  vec2 pixel=vec2(uv.x*uSize.x,(1.-uv.y)*uSize.y);
  vec2 actorPixel=(uActorMap*vec3(pixel,1.)).xy;
  float actorAlpha=texture2D(uActorMask,vec2(actorPixel.x/440.,1.-actorPixel.y/534.)).a;
  // The paintings vary slightly from the source cutout around the tail and mat.
  vec2 footprint=smoothstep(vec2(-75.,85.),vec2(-60.,100.),actorPixel)
      *(1.-smoothstep(vec2(480.,550.),vec2(495.,565.),actorPixel));
  float removal=max(actorAlpha,footprint.x*footprint.y)*uRemoveActor;
  source.rgb=mix(source.rgb,texture2D(uClean,uv).rgb,removal);
 }
 return source;
}

void main(){
 vec4 source=artwork(vUv);vec3 color=source.rgb;
 vec2 pixel=vec2(vUv.x*uSize.x,(1.-vUv.y)*uSize.y);
 color=companionExpression(color,pixel);
 float outer=texture2D(uOuter,vUv).a,inside=texture2D(uInterior,vUv).a;
 if(uCompare<.5){
  vec3 wave=water(pixel);
  if(uScene<.5){
   vec2 q=(pixel-vec2(428.,837.))/vec2(390.,465.);
   float blueGlass=smoothstep(.006,.12,source.b-min(source.r,source.g));
   float shell=outer*smoothstep(.65,.86,length(q))*blueGlass;
   vec2 displacement=wave.xy*vec2(15.,19.)*uFlow*shell;
   vec2 refractedUv=vUv+displacement/vec2(uSize.x,-uSize.y);
   color=mix(color,artwork(refractedUv).rgb,shell*.92);

   float distanceFromLamp=length((pixel-vec2(420.,625.))/vec2(320.,590.));
   float spread=smoothstep(distanceFromLamp-.24,distanceFromLamp+.24,uLamp*1.85)*clamp(uLamp*5.,0.,1.);
   vec3 unlit=color*vec3(.15,.22,.40);color=mix(color,mix(unlit,color,spread),inside);
   float reflectedWarmth=exp(-pow((pixel.x-480.)/340.,2.)-pow((pixel.y-1280.)/240.,2.));
   color*=1.-.23*(1.-uLamp)*max(outer,reflectedWarmth);
   float bulb=exp(-pow((pixel.x-421.)/28.,2.)-pow((pixel.y-639.)/12.,2.));
   float halo=exp(-pow((pixel.x-422.)/67.,2.)-pow((pixel.y-650.)/58.,2.));
   color+=uLamp*(bulb*.34+halo*.038)*vec3(1.,.76,.43);

   // Refraction, surface normals and specular highlights use the same wave phase.
   vec3 normal=normalize(vec3(q*.24+wave.xy*.55,1.));
   vec3 halfLight=normalize(vec3(-.45,.68,1.));
   float specular=pow(max(dot(normal,halfLight),0.),22.);
   float caustic=pow(clamp(.48+.30*wave.z+.21*sin(dot(pixel,vec2(.018,-.027))+uTime*.85),0.,1.),5.);
   color*=1.+shell*uFlow*wave.z*.12;
   color+=(specular*.16+caustic*.28)*uFlow*shell*vec3(.48,.70,1.);
   // Animate the light paths already present in the side glass, using their original luminance.
   float sideY=smoothstep(545.,625.,pixel.y)*(1.-smoothstep(1220.,1300.,pixel.y));
   float leftSide=smoothstep(28.,56.,pixel.x)*(1.-smoothstep(175.,210.,pixel.x))*sideY;
   float rightSide=smoothstep(722.,758.,pixel.x)*(1.-smoothstep(807.,833.,pixel.x))*sideY;
   float originalLight=smoothstep(.060,.33,dot(source.rgb,vec3(.2126,.7152,.0722)));
   float upward=pow(.5+.5*sin(pixel.y*.021+uTime*1.7+pixel.x*.009),3.);
   float downward=pow(.5+.5*sin(pixel.y*.024-uTime*1.4-pixel.x*.007),3.);
   float sideCurrent=(leftSide*upward+rightSide*downward)*outer*originalLight*uFlow;
   color*=1.+sideCurrent*.22;
   color+=sideCurrent*.14*vec3(.48,.72,1.);
   float innerShimmer=pow(max(0.,.35+.25*sin(pixel.x*.022+pixel.y*.013-uTime*1.3)+.25*cos(pixel.x*.009-pixel.y*.026-uTime*.8)),6.);
   color+=innerShimmer*uFlow*inside*.016*vec3(1.,.80,.51);
   // Project the same water surface onto the floor. The mirrored coordinates keep
   // the moving reflected highlights attached to their source in the glass.
   float reflectionMask=exp(-pow((pixel.x-430.)/355.,4.)-pow((pixel.y-1385.)/125.,2.))
       *smoothstep(1295.,1320.,pixel.y)*(1.-smoothstep(1500.,1585.,pixel.y));
   vec2 mirrorPixel=vec2(pixel.x,1295.-(pixel.y-1295.)*.86);
   vec3 reflectedWave=water(mirrorPixel);
   vec2 reflectedUv=vUv+reflectedWave.xy*vec2(10.,15.)/vec2(uSize.x,-uSize.y)*uFlow;
   vec3 floorSample=artwork(reflectedUv).rgb;
   color=mix(color,floorSample,reflectionMask*uFlow*.82);
   vec2 reflectedQ=(mirrorPixel-vec2(428.,837.))/vec2(390.,465.);
   vec3 reflectedNormal=normalize(vec3(reflectedQ*.24+reflectedWave.xy*.55,1.));
   float reflectedSpecular=pow(max(dot(reflectedNormal,halfLight),0.),22.);
   float reflectedCaustic=pow(clamp(.48+.30*reflectedWave.z+.21*sin(dot(mirrorPixel,vec2(.018,-.027))+uTime*.85),0.,1.),5.);
   vec3 reflectedSource=artwork(vec2(mirrorPixel.x/uSize.x,1.-mirrorPixel.y/uSize.y)).rgb;
   float reflectedBlue=smoothstep(.006,.12,reflectedSource.b-min(reflectedSource.r,reflectedSource.g));
   vec3 reflectedTint=mix(vec3(1.,.69,.34),vec3(.35,.60,1.),reflectedBlue);
   float movingReflection=(reflectedSpecular*.32+reflectedCaustic*.52)*uFlow;
   color*=1.+reflectionMask*uFlow*(reflectedWave.z*.26+reflectedSpecular*.24);
   color+=reflectionMask*movingReflection*reflectedTint;
   float warmPool=exp(-pow((pixel.x-563.)/143.,2.)-pow((pixel.y-1380.)/105.,2.));
   float warmRipple=.52+.28*sin(uTime*1.42+reflectedWave.z*1.35)+reflectedCaustic*.75;
   color+=warmPool*uLamp*uFlow*warmRipple*.055*vec3(1.,.65,.31);
   color*=1.-reflectionMask*(1.-uLamp)*.48;
  }else{
   vec2 q=(pixel-vec2(426.,768.))/vec2(402.,435.);
   float core=inside*(1.-smoothstep(800.,850.,pixel.y));
   // Large, slow material folds give the pearl star a gelatin surface rather than water ripples.
   vec2 gel=vec2(sin(pixel.x*.009+pixel.y*.003-uTime*1.14)+.25*sin(pixel.y*.013-uTime*.8),
       cos(pixel.y*.008-pixel.x*.004-uTime*1.02));
   vec2 offset=gel*vec2(4.,5.)/vec2(uSize.x,-uSize.y)*uFlow*core;
   color=mix(color,artwork(vUv+offset).rgb,core);
   color=mix(color*.44,color,mix(1.,uLamp,core));
   float band=outer*smoothstep(.66,.85,length(q));
   vec3 gelNormal=normalize(vec3(q*.34+gel*.12,1.));
   float specular=pow(max(dot(gelNormal,normalize(vec3(-.4,-.65,1.))),0.),26.);
   color+=specular*outer*uFlow*.065*vec3(.72,.83,1.);
   float sheen=pow(clamp(.55+gel.x*.18+gel.y*.14,0.,1.),4.)*band*uFlow;
   color=mix(color,color*vec3(.94,.98,1.05)+vec3(.02,.04,.07),sheen*.38);
   float glow=exp(-pow((pixel.x-426.)/260.,2.)-pow((pixel.y-695.)/265.,2.))*core;
   color+=glow*uLamp*.035*vec3(.5,.68,1.);
  }
 }
 gl_FragColor=vec4(color,1.-uExit);
 #include <colorspace_fragment>
}`;
