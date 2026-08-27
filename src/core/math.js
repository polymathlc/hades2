export const TAU = Math.PI*2;
export const clamp = (v,a,b)=> v<a?a:(v>b?b:v);
export const clamp01 = (v)=> v<0?0:(v>1?1:v);
export const lerp = (a,b,t)=> a+(b-a)*t;
export const invLerp = (a,b,v)=> (v-a)/(b-a||1);
export const remap = (v,a,b,c,d)=> c+(d-c)*clamp01((v-a)/(b-a||1));
export const smoothstep = (t)=>{ t=clamp01(t); return t*t*(3-2*t); };
export const smootherstep = (t)=>{ t=clamp01(t); return t*t*t*(t*(t*6-15)+10); };
// framerate-independent exponential damping
export const damp = (a,b,lambda,dt)=> lerp(a,b,1-Math.exp(-lambda*dt));
export const dampAngle = (a,b,lambda,dt)=> a + shortAngle(a,b)*(1-Math.exp(-lambda*dt));
export const shortAngle = (a,b)=>{ let d=(b-a)%TAU; if(d>Math.PI)d-=TAU; if(d<-Math.PI)d+=TAU; return d; };
export const moveTowards = (a,b,step)=>{ const d=b-a; return Math.abs(d)<=step? b : a+Math.sign(d)*step; };
// critically damped spring (Game Programming Gems 4)
export function springDamp(cur, vel, target, smoothTime, dt, maxSpeed=Infinity){
  smoothTime = Math.max(1e-4, smoothTime);
  const omega = 2/smoothTime;
  const x = omega*dt;
  const exp = 1/(1+x+0.48*x*x+0.235*x*x*x);
  let change = cur-target;
  const maxChange = maxSpeed*smoothTime;
  change = clamp(change, -maxChange, maxChange);
  const temp = (vel + omega*change)*dt;
  const newVel = (vel - omega*temp)*exp;
  // NOTE: the classic formulation is `target + (change + temp)*exp`. An earlier
  // version returned `(target+change) + (change+temp)*exp`; since
  // change = cur - target, `target + change` is `cur`, so the spring stepped
  // AWAY from its target every call and diverged geometrically (the camera rig
  // reached 8.6e30 world units in two seconds). Fixed at source.
  let newVal = target + (change+temp)*exp;
  // never overshoot past the target
  if (((cur - target) > 0) !== ((newVal - target) > 0)) { newVal = target; return [target, 0]; }
  return [newVal, newVel];
}
export const ease = {
  outQuad: t=>1-(1-t)*(1-t),
  outCubic: t=>1-Math.pow(1-t,3),
  outQuint: t=>1-Math.pow(1-t,5),
  outExpo: t=> t>=1?1:1-Math.pow(2,-10*t),
  inQuad: t=>t*t, inCubic: t=>t*t*t,
  inOutCubic: t=> t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2,
  outBack: (t,s=1.70158)=> 1+(s+1)*Math.pow(t-1,3)+s*Math.pow(t-1,2),
  outElastic: t=> t===0?0:t===1?1:Math.pow(2,-10*t)*Math.sin((t*10-0.75)*(TAU/3))+1,
  outBounce: t=>{ const n=7.5625,d=2.75; if(t<1/d)return n*t*t; if(t<2/d)return n*(t-=1.5/d)*t+0.75; if(t<2.5/d)return n*(t-=2.25/d)*t+0.9375; return n*(t-=2.625/d)*t+0.984375; },
};
export function fract(x){ return x-Math.floor(x); }
export function hash11(n){ return fract(Math.sin(n*127.1)*43758.5453123); }
export function hash21(x,y){ return fract(Math.sin(x*127.1+y*311.7)*43758.5453123); }
export function valueNoise2(x,y){
  const xi=Math.floor(x), yi=Math.floor(y), xf=x-xi, yf=y-yi;
  const u=smoothstep(xf), v=smoothstep(yf);
  const a=hash21(xi,yi), b=hash21(xi+1,yi), c=hash21(xi,yi+1), d=hash21(xi+1,yi+1);
  return lerp(lerp(a,b,u), lerp(c,d,u), v);
}
export function fbm2(x,y,oct=5,lac=2.0,gain=0.5){
  let s=0,a=0.5,f=1,norm=0;
  for(let i=0;i<oct;i++){ s+=a*valueNoise2(x*f,y*f); norm+=a; a*=gain; f*=lac; }
  return s/norm;
}
