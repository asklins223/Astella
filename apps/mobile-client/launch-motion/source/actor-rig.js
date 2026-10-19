// Shared image-space puppet rig. The exact approved character pixels remain the source.
export const actorUniforms=`
uniform mat3 uActorMap,uActorToScene,uBlinkMap;
uniform sampler2D uBlink;
uniform vec2 uBlinkSize;
uniform float uActor;
`;

export const actorVertex=`
float softBone(vec2 p,vec2 center,vec2 radius){return 1.-smoothstep(.78,1.18,length((p-center)/radius));}
vec2 rotateBone(vec2 relative,float angle){float c=cos(angle),s=sin(angle);return mat2(c,s,-s,c)*relative-relative;}
vec2 companionDisplacement(vec2 pixel){
 vec2 local=(uActorMap*vec3(pixel,1.)).xy;
 float t=mod(uTime,9.);
 float looking=smoothstep(3.35,4.10,t)*(1.-smoothstep(5.65,6.45,t));
 float writing=1.-looking;
 float headWeight=softBone(local,vec2(183.,263.),vec2(151.,152.));
 float headAngle=mix(.024,-.025,looking)+sin(t*1.3962634)*.008*writing;
 vec2 delta=rotateBone(local-vec2(183.,369.),headAngle)*headWeight;
 delta.y+=(sin(t*4.1887902)*1.8*writing-looking*3.)*headWeight;
 float handWeight=softBone(local,vec2(128.,382.),vec2(39.,45.));
 float stroke=sin(t*8.3775804);
 delta+=vec2(stroke*3.1,cos(t*8.3775804)*1.5)*handWeight*writing;
 delta+=rotateBone(local-vec2(137.,408.),stroke*.05)*handWeight*writing;
 float tailWeight=softBone(local,vec2(356.,348.),vec2(97.,108.));
 float tailDelay=clamp((local.x-280.)/160.,0.,1.)*.30;
 float tailAngle=sin(t*1.3962634-tailDelay)*.064;
 delta+=rotateBone(local-vec2(276.,429.),tailAngle)*tailWeight;
 vec2 inScene=(uActorToScene*vec3(delta,0.)).xy;
 return vec2(inScene.x,-inScene.y)*uActor;
}
`;

export const actorFragment=`
vec3 companionExpression(vec3 originalColor,vec2 pixel){
 vec2 local=(uActorMap*vec3(pixel,1.)).xy;
 float first=mod(uTime-2.65+9.,9.);
 float second=mod(uTime-6.85+9.,9.);
 float blinkA=smoothstep(0.,.065,first)*(1.-smoothstep(.13,.25,first));
 float blinkB=smoothstep(0.,.065,second)*(1.-smoothstep(.13,.25,second));
 float eyeA=1.-smoothstep(.80,1.12,length((local-vec2(144.,317.))/vec2(29.,28.)));
 float eyeB=1.-smoothstep(.80,1.12,length((local-vec2(218.,317.))/vec2(30.,28.)));
 vec2 blinkPixel=(uBlinkMap*vec3(pixel,1.)).xy;
 vec2 uv=vec2(blinkPixel.x/uBlinkSize.x,1.-blinkPixel.y/uBlinkSize.y);
 vec4 closed=texture2D(uBlink,uv);
 float amount=max(blinkA,blinkB)*max(eyeA,eyeB)*closed.a*uActor;
 return mix(originalColor,closed.rgb,amount);
}
`;
