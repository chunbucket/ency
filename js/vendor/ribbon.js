/* ribbon.js — the mesh.
 *
 * A parametric Möbius ribbon rasterized live into a character grid (each cell
 * shaded by the surface's angle to the light and its depth, with a z-buffer so
 * the sheet occludes itself as it turns), which then resolves into the arc
 * mark: every character travels from its spot on the 3D sheet to a target
 * inside the logo's filled path. Same characters throughout — no crossfade.
 *
 * Ported from the "ㄴ + ㅅ — ASCII Ribbon Morph" artifact
 * (claude.ai/code/artifact/30226fb8-9091-4143-88a1-7a52ceb6c557).
 * The geometry, shading, morph staggering and idle motion are unchanged from
 * there. What changed for this site:
 *   1. it no longer reaches for control markup by id, so the public page and
 *      the studio share one renderer;
 *   2. `paper` joined the state object (it was a CSS variable in the artifact);
 *   3. the focal length is clamped for fullscreen — see build().
 */
(function (global) {
  'use strict';

  var RAMPS = { ascii: " .·:-=+*ox%#@", blocks: " ·░▒▓█", binary: " ..01" };

  // Also the shape the studio publishes and the public page loads.
  var DEFAULTS = {
    twist: 1, charset: 'ascii', tempo: 1, loop: true, random: false,
    gran: 130, float: 1, bend: 1, trail: 0.35, gather: 0, reveal: 'auto',
    ambient: 1.5, chaos: 1.2, mouse: 0.5, freedom: 0.4,
    scale: 1, thin: 0, rotate: 0, holo: 0, holoWide: 0.35, recede: 1, field: 0, ink: '#c0c0c0', paper: '#232323'
  };

  var KEYS = Object.keys(DEFAULTS);

  // Only known keys, only the right types — this parses whatever the server
  // hands back, which is whatever was on disk.
  function sanitize(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i], v = raw[k], d = DEFAULTS[k];
      if (v === undefined || v === null) continue;
      if (typeof d === 'number' && typeof v === 'number' && isFinite(v)) out[k] = v;
      else if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
      else if (typeof d === 'string' && typeof v === 'string') out[k] = v;
    }
    return out;
  }

  function createRibbon(opts) {
    var sheet = opts.container, cv = opts.canvas, ctx = cv.getContext('2d');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var state = Object.assign({}, DEFAULTS, sanitize(opts.state));

  var WRITE_CHANCE=0.2;  // in Auto reveal, how often a cycle hand-writes instead of sweeping
  var SPIN=2.4, RES=4.4, T0=SPIN+RES;   // one-time intro: ribbon forms the mark (RES = time to form)
  // infinite cycle phases (seconds). REF===RES → formation speed matches intro & every loop.
  // Tumble length = state.ambient (user-controlled). Seam sits on the fully-formed hold state.
  var HOLD=2.4, DISS=3.4, REF=4.4;
  var mp={phase:0.6,dir:1,rate:0.7,tilt:-0.5,rz:0}; // current motion params
  function rollMotion(){
    if(state.random){
      mp={ phase:Math.random()*6.283, dir:Math.random()<0.5?-1:1,
           rate:0.5+Math.random()*0.95, tilt:-(0.3+Math.random()*0.55),
           rz:(Math.random()-0.5)*1.15, tw:1+Math.floor(Math.random()*2) };   // twist ≤2: three folds read as tangle
    } else { mp={phase:0.6,dir:1,rate:0.7,tilt:-0.5,rz:0,tw:state.twist}; }
    // reveal order for THIS cycle: auto = mostly sweep, occasionally hand-write
    mp.write = state.reveal==='write' ? true : state.reveal==='sweep' ? false : (Math.random()<WRITE_CHANCE);
    // ~1 in 3 cycles the swarm briefly coalesces into a clean Möbius mid-drift
    mp.showMobius = Math.random()<0.34;
  }

  // value-noise for a faint background mesh. The lattice hash is precomputed
  // once into a wrapped table — the same field, none of the per-cell Math.sin
  // (at high gran the old form burned ~700k sin calls per frame).
  var HSZ=512, HTAB=new Float32Array(HSZ*HSZ);
  (function(){ for(var y=0;y<HSZ;y++)for(var x=0;x<HSZ;x++){ var n=Math.sin(x*127.1+y*311.7)*43758.5453; HTAB[y*HSZ+x]=n-Math.floor(n); } })();
  function h(x,y){ return HTAB[((y&511)<<9)|(x&511)]; }
  function vn(x,y){var xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    var u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
    var a=h(xi,yi),b=h(xi+1,yi),c=h(xi,yi+1),d=h(xi+1,yi+1);
    return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v;}
  function fbm(x,y){var f=0,a=.5,s=0;for(var i=0;i<3;i++){f+=a*vn(x,y);s+=a;x*=2.02;y*=2.02;a*=.5;}return f/s;}
  function smoother(t){t=t<0?0:t>1?1:t;return t*t*t*(t*(t*6-15)+10);}

  // ---- ribbon geometry (Möbius family) ----
  var HW=0.62;
  function ribPt(u,v,tw){
    var r=1.0 + v*HW*Math.cos(tw*u/2);
    return [ r*Math.cos(u), r*Math.sin(u), v*HW*Math.sin(tw*u/2) ];
  }
  function rotY(p,a){var c=Math.cos(a),s=Math.sin(a);return [c*p[0]+s*p[2],p[1],-s*p[0]+c*p[2]];}
  function rotX(p,a){var c=Math.cos(a),s=Math.sin(a);return [p[0],c*p[1]-s*p[2],s*p[1]+c*p[2]];}
  function rotZ(p,a){var c=Math.cos(a),s=Math.sin(a);return [c*p[0]-s*p[1],s*p[0]+c*p[1],p[2]];}
  var Lx=0.35,Ly=0.5,Lz=0.79; // light dir (normalized-ish)
  // A lamp at a POSITION, not a direction. Holodisc's light is a point
  // (u_light.xy - p), so the direction to it differs across the surface and the
  // catch is a localised highlight that travels — rather than the whole sheet
  // flaring at once, which is what a light-at-infinity gives you.
  var LPx=1.7, LPy=2.0, LPz=-2.4;

  // Visible-spectrum wavelength (nm) to rgb — lifted from holodisc's shader so
  // the mesh iridesces off the same physics rather than a hue cycle.
  function wl2rgb(w){
    var r,g,b;
    if      (w<440.0){ r=(440.0-w)/60.0; g=0.0; b=1.0; }
    else if (w<490.0){ r=0.0; g=(w-440.0)/50.0; b=1.0; }
    else if (w<510.0){ r=0.0; g=1.0; b=(510.0-w)/20.0; }
    else if (w<580.0){ r=(w-510.0)/70.0; g=1.0; b=0.0; }
    else if (w<645.0){ r=1.0; g=(645.0-w)/65.0; b=0.0; }
    else             { r=1.0; g=0.0; b=0.0; }
    var a=1.0;
    if (w<420.0) a=0.3+0.7*(w-380.0)/40.0;
    if (w>700.0) a=0.3+0.7*(780.0-w)/80.0;
    return [Math.max(0,Math.min(1,r))*a, Math.max(0,Math.min(1,g))*a, Math.max(0,Math.min(1,b))*a];
  }

  // The lamp does not move. Holodisc's diffraction is a function of screen
  // position against a fixed light and eye — the disc spins *through* a
  // stationary rainbow rather than carrying one around. So this is keyed to the
  // cell's place on screen, not to the ribbon's orientation: the mesh travels
  // through the field. It also means the whole thing precomputes on resize and
  // costs nothing per frame.
  var holoIdx=null, LGT=[-0.35,0.55,0.90];
  function buildHoloField(){
    holoIdx=new Uint16Array(cols*rows);
    var R=Math.min(W,H)*0.75, SAT=0.62;
    for(var gy=0;gy<rows;gy++)for(var gx=0;gx<cols;gx++){
      var px=((gx+0.5)*cellW - W*0.5)/R, py=((gy+0.5)*cellH - H*0.5)/R;
      var rr=Math.sqrt(px*px+py*py)||1e-4, urx=px/rr, ury=py/rr;   // radial grating, as on a disc
      var wx=LGT[0]-px, wy=LGT[1]-py, wz=LGT[2];                    // point -> light
      var wl_=Math.sqrt(wx*wx+wy*wy+wz*wz); wx/=wl_; wy/=wl_;
      var ox=-px*0.35, oy=-py*0.35, oz=1.7;                         // point -> eye
      var ol=Math.sqrt(ox*ox+oy*oy+oz*oz); ox/=ol; oy/=ol;
      var sd=(wx*urx+wy*ury)+(ox*urx+oy*ury);                       // the grating term
      var r=0,g=0,b=0;
      for(var mo=1;mo<=4;mo++){                                     // sum the diffraction orders
        var w=1600.0*Math.abs(sd)/mo;
        if(w>380.0&&w<780.0){ var c=wl2rgb(w), k=1.4/mo; r+=c[0]*k; g+=c[1]*k; b+=c[2]*k; }
      }
      var mx=Math.max(r,g,b); if(mx>1){ r/=mx; g/=mx; b/=mx; }
      var lum=r*0.2126+g*0.7152+b*0.0722;                           // holodisc's u_sat
      r=lum+(r-lum)*SAT; g=lum+(g-lum)*SAT; b=lum+(b-lum)*SAT;
      holoIdx[gy*cols+gx]=((r*15+0.5)|0)<<8 | ((g*15+0.5)|0)<<4 | ((b*15+0.5)|0);
    }
  }

  // ---- the real logo: filled path from mark.svg (encylogo_tilt_v4, viewBox 7566x7321) ----
  var LOGO_VB=[7566,7321];   // encylogo_tilt_v4.svg viewBox
  var LOGO_D="M1475.84 5897.34C703.291 4627.93 1418.26 2401.32 1728.89 1058.81C1512.08 990.59 620.672 1329.14 602.638 1456.01C602.533 1456.75 602.426 1457.36 602.24 1458.08C182.898 3073.58 -661.767 6363.6 929.033 7146.25C2128.65 7736.45 4935.65 6635.06 7559.35 6722.15C7660.92 6106.8 6370.61 4875.34 5939.95 4496.97C5513.08 4121.93 4551.4 3563.23 4364.59 3317.54C4361.4 3313.35 4360.67 3308.99 4362.82 3304.18C4555.39 2872.51 6213.61 594.713 6425.39 319.221C6356.53 197.359 5268.79 -89.7754 5153.44 27.638C4388.79 690.883 1680.75 5613.28 1475.84 5897.34ZM3746.32 4372.64C3743.04 4372.56 3740.79 4373.6 3738.26 4375.69C3404.65 4651.71 2669.3 5844.18 2525.65 6332.94C2522.41 6343.96 2532.22 6353.61 2543.34 6350.74C3425.09 6123.67 5028.63 5843.76 5756.98 5913.68C5764.93 5914.45 5771.79 5909.54 5770.95 5901.6C5742.99 5637.07 4005.97 4379.15 3746.32 4372.64Z";

  // ---- grid + buffers ----
  var cols,rows,cellW,cellH,W,H,dpr,zbuf,rib,glint,f,cx,cy;
  // the faint background field lives on its own layer, refreshed every few
  // frames — it evolves slowly, and it's most of the cells at high gran
  var bgCv=document.createElement('canvas'), bctx=bgCv.getContext('2d'), bgTick=0;
  // per-cell weld level: rises the moment a cell's grain has fully landed,
  // falls the moment it starts to lift — the fuse rides the morph's own wave
  var weldBuf=null;
  var holoCache=null, holoCacheKey='', cacheInk=[192,192,192];
  // the quantised diffraction colour for a cell, cached per (cell colour, level)
  function holoColorAt(idxc, lv, holo){
    var key=(holoIdx[idxc]<<3)|lv, cc=holoCache[key];
    if(cc===undefined){
      var q=holoIdx[idxc], a=(lv+0.5)/8*holo;
      var fr=((q>>8)&15)/15*255, fg=((q>>4)&15)/15*255, fb=(q&15)/15*255;
      cc='rgb('+((cacheInk[0]+(fr-cacheInk[0])*a)|0)+','
               +((cacheInk[1]+(fg-cacheInk[1])*a)|0)+','
               +((cacheInk[2]+(fb-cacheInk[2])*a)|0)+')';
      holoCache[key]=cc;
    }
    return cc;
  }

  // plain-ink glyphs are stamped from prebaked tiles instead of fillText —
  // holo-tinted cells (a handful per frame) keep the live text path. Drawn
  // at fractional coordinates the tiles get bilinear sub-pixel placement, so
  // the idle motion stays smooth. One size only: uniform, nothing pops.
  var atlas=null, atlasKey='', atlasTW=0, atlasTH=0;
  function buildAtlas(){
    var ramp=RAMPS[state.charset];
    var key=state.charset+'|'+state.ink+'|'+cellH.toFixed(2)+'|'+dpr;
    if(key===atlasKey&&atlas) return;
    atlasKey=key; atlas=[];
    atlasTW=Math.ceil(cellW*1.1)+4; atlasTH=Math.ceil(cellH*1.1)+4;
    for(var i=0;i<ramp.length;i++){
      var ch=ramp.charAt(i);
      if(ch===' '){ atlas.push(null); continue; }
      var c=document.createElement('canvas');
      c.width=atlasTW*dpr; c.height=atlasTH*dpr;
      var g=c.getContext('2d');
      g.setTransform(dpr,0,0,dpr,0,0);
      // a hair over cell height, so landed blocks touch and the resting
      // mark reads as one merged silhouette
      g.font='700 '+(cellH*1.02)+'px "SF Mono", ui-monospace, Menlo, Consolas, monospace';
      g.textBaseline='top'; g.textAlign='left';
      g.fillStyle=state.ink;
      g.fillText(ch,2,2);
      atlas.push(c);
    }
  }
  var TX,TY,TF,TW,TN=0, originX=0, originY=0;  // targets + seed-stagger + write-order stagger + origin point
  var fitS=1, fitX=0, fitY=0, logoPath=null;    // SVG→screen fit + cached vector path (set in build)
  // pen path in SVG (7566x7321, logo v4 tilt) coords, in writing order:
  //  ㄴ: down the left, then right to the corner · ㅅ: up the right leg to the junction and on to the apex, then the long leg down-left
  var WRITE_PATH=[[620,1451],[947,7142],[7536,6749],[5960,4460],[4364,3317],[6421,314],[4364,3317],[1475,5899]];
  function buildWriteOrder(){
    if(!TN) return;
    var a=-state.rotate*Math.PI/180, ca=Math.cos(a), sa=Math.sin(a), hx=LOGO_VB[0]/2, hy=LOGO_VB[1]/2;
    var pts=WRITE_PATH.map(function(p){ var x=p[0]-hx, y=p[1]-hy;   // same rotation as the mask
      return [fitX+(hx+x*ca-y*sa)*fitS, fitY+(hy+x*sa+y*ca)*fitS]; });
    var seg=[],cum=[0],total=0;
    for(var i=0;i<pts.length-1;i++){ var dx=pts[i+1][0]-pts[i][0],dy=pts[i+1][1]-pts[i][1],L=Math.sqrt(dx*dx+dy*dy); seg.push(L); total+=L; cum.push(total); }
    TW=new Float32Array(TN);
    for(var t=0;t<TN;t++){ var qx=TX[t],qy=TY[t],best=1e18,arc=0;
      for(var i=0;i<pts.length-1;i++){ var ax=pts[i][0],ay=pts[i][1],vx=pts[i+1][0]-ax,vy=pts[i+1][1]-ay,ll=vx*vx+vy*vy||1;
        var u=((qx-ax)*vx+(qy-ay)*vy)/ll; if(u<0)u=0; if(u>1)u=1;
        var dx=qx-(ax+vx*u),dy=qy-(ay+vy*u),dd=dx*dx+dy*dy;
        if(dd<best){ best=dd; arc=cum[i]+seg[i]*u; } }
      TW[t]=total?arc/total:0; }
  }
  // fill TF from distance to a chosen origin target → the sweep starts/collapses at that point
  function computeStagger(oi){
    if(!TN) return; var oxp=TX[oi]||TX[0], oyp=TY[oi]||TY[0], mx=1e-6;
    originX=oxp; originY=oyp;
    for(var i=0;i<TN;i++){ var dx=TX[i]-oxp, dy=TY[i]-oyp, dd=Math.sqrt(dx*dx+dy*dy); TF[i]=dd; if(dd>mx)mx=dd; }
    for(var i=0;i<TN;i++) TF[i]/=mx;
  }
  function rand(n){ return (Math.random()*n)|0; }
  function build(){
    dpr=Math.min(2,window.devicePixelRatio||1);
    W=sheet.clientWidth; H=sheet.clientHeight;
    cellW=Math.max(3,W/state.gran); cellH=cellW/0.55;
    cols=Math.ceil(W/cellW); rows=Math.ceil(H/cellH);
    cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.textBaseline='top'; ctx.textAlign='left';
    bgCv.width=W*dpr; bgCv.height=H*dpr; bctx.setTransform(dpr,0,0,dpr,0,0);
    weldBuf=new Float32Array(cols*rows);
    bgTick=0;
    zbuf=new Float32Array(cols*rows); rib=new Float32Array(cols*rows);
    glint=new Float32Array(cols*rows);   // how hard this cell is catching the light, 3D
    buildHoloField();                 // stationary diffraction field, recomputed on resize
    dispX=new Float32Array(cols*rows); dispY=new Float32Array(cols*rows);   // cursor-swipe displacement per grain
    // `scale` sizes the whole composition: it multiplies the ribbon's focal
    // length and the mark's fit by the same factor, so the two stay in
    // proportion through the morph. Scaling only one would land the characters
    // somewhere the ribbon never was.
    var S=state.scale;
    f=Math.min(W*0.60,H*0.80)*S; cx=W/2; cy=H*0.5;
    // rasterize the SVG fill at grid resolution → collect target cells
    var mc=document.createElement('canvas'); mc.width=cols; mc.height=rows;
    var m=mc.getContext('2d');
    var scale=Math.min((W*0.42*S)/LOGO_VB[0], (H*0.66*S)/LOGO_VB[1]); // fit, centered
    var offx=(W-LOGO_VB[0]*scale)/2, offy=(H-LOGO_VB[1]*scale)/2;
    fitS=scale; fitX=offx; fitY=offy;   // remember for the write-path mapping
    m.setTransform(scale/cellW,0,0,scale/cellH, offx/cellW, offy/cellH);
    // `rotate` turns the artwork about the viewBox centre (degrees, counter-clockwise
    // on screen), in SVG space so the anisotropic cell fit is applied afterwards
    if(state.rotate){ m.translate(LOGO_VB[0]/2,LOGO_VB[1]/2); m.rotate(-state.rotate*Math.PI/180); m.translate(-LOGO_VB[0]/2,-LOGO_VB[1]/2); }
    m.fillStyle='#000'; m.fill(new Path2D(LOGO_D),'evenodd');
    // `thin` knocks a band off every edge of the fill (holes widen too), so the
    // strokes lose 2×thin×(viewBox max side) of weight uniformly, in the
    // logo's own units — the same visual weight on every viewport.
    if(state.thin>0){
      m.globalCompositeOperation='destination-out';
      m.lineWidth=2*state.thin*Math.max(LOGO_VB[0],LOGO_VB[1]); m.lineJoin='round';
      m.stroke(new Path2D(LOGO_D));
      m.globalCompositeOperation='source-over';
    }
    var d=m.getImageData(0,0,cols,rows).data;
    var list=[];
    for(var gy=0;gy<rows;gy++)for(var gx=0;gx<cols;gx++){
      if(d[(gy*cols+gx)*4+3]>90) list.push([gx,gy]);
    }
    // sweep order: top-to-bottom with a slight left-to-right bias → mark draws on in a sweep
    list.sort(function(a,b){ return (a[1]*1.0+a[0]*0.28)-(b[1]*1.0+b[0]*0.28); });
    TN=list.length; TX=new Float32Array(TN); TY=new Float32Array(TN); TF=new Float32Array(TN);
    for(var i=0;i<TN;i++){ TX[i]=list[i][0]*cellW+cellW*0.5; TY[i]=list[i][1]*cellH+cellH*0.5; }
    computeStagger(0); // default origin (top); randomized per-cycle at runtime
    buildWriteOrder(); // order cells along the ㄴ→ㅅ pen path (for Write mode)
    logoPath=new Path2D(LOGO_D); // cached vector for the solid-at-rest crossfade
    buildAtlas();      // glyph tiles for the current charset/ink/cell size
  }

  // p = overall reflow progress 0..1 (0 = pure spinning ribbon, 1 = fully-formed mark)
  var HOLO_EXP=11.0;   // angular tolerance of the catch, set from holoWide each frame
  function renderRibbon(spin,tilt,roll,tw,p,tsec,chaosAmt,Wp){
    for(var i=0;i<zbuf.length;i++){zbuf[i]=1e9;rib[i]=0;glint[i]=0;weldBuf[i]=0;}
    var N=700,M=56,du=6.2832/N,dv=2/(M-1),D=3.7,K=N*M; // dense enough to fill even extreme detail without gaps
    // a forming FRONT sweeps out from the seed point (targets ordered by distance = TF).
    // Trail tightens the front → a narrow wave that draws the mark from the seed outward.
    var BAND=0.14+(1-state.trail)*0.95, front=p*(1+BAND);
    var wBand=BAND*2.5;   // wide: the weld reads as a soft global set, not a visible wave
    var k=-1;
    for(var i=0;i<N;i++){
      var uu=i*du;
      for(var j=0;j<M;j++){
        k++;
        // each ribbon sample is assigned a fill-target inside the real logo shape
        var trank = TN? (k*TN/K)|0 : 0; if(trank>=TN) trank=TN-1;
        var orderFrac = TN? (mp.write? TW[trank] : TF[trank]) : 0;   // this cycle's order: pen-write or seed-sweep
        var mmi=(front-orderFrac)/BAND; mmi=mmi<0?0:mmi>1?1:mmi; mmi=smoother(mmi);
        // the weld front: same stagger order, same band shape, its own sweep
        var wmi=Wp>0?(Wp-orderFrac)/wBand:0; wmi=wmi<0?0:wmi>1?1:wmi; if(wmi>0&&wmi<1)wmi=smoother(wmi);
        var zScale=1-mmi;
        var vv=-1+j*dv;
        var q=ribPt(uu,vv,tw);
        if(chaosAmt>0.001){   // scatter the ribbon into a drifting swarm (fades as it forms via the mmi blend)
          q[0]+=(vn(uu*0.7+chaosT, vv*1.1)-0.5)*chaosAmt;
          q[1]+=(vn(uu*0.7+9.1, vv*1.1+chaosT)-0.5)*chaosAmt;
          q[2]+=(vn(uu*0.7+chaosT*0.8, vv*1.1+4.2)-0.5)*chaosAmt*0.8;
        }
        var pa=ribPt(uu+0.012,vv,tw), pb=ribPt(uu,vv+0.012,tw);
        var ex0=pa[0]-q[0],ex1=pa[1]-q[1],ex2=pa[2]-q[2];
        var ev0=pb[0]-q[0],ev1=pb[1]-q[1],ev2=pb[2]-q[2];
        var nx=ex1*ev2-ex2*ev1, ny=ex2*ev0-ex0*ev2, nz=ex0*ev1-ex1*ev0;
        var nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1; nx/=nl;ny/=nl;nz/=nl;
        var pp=rotZ(rotX(rotY([q[0],q[1],q[2]*zScale],spin),tilt),roll);
        var n=rotZ(rotX(rotY([nx,ny,nz],spin),tilt),roll);
        var pz=pp[2]+D; if(pz<=0.2) continue;
        var px=cx+f*pp[0]/pz, py=cy-f*pp[1]/pz;      // 3D-projected screen pos
        var tsx=TN?TX[trank]:px, tsy=TN?TY[trank]:py;  // static home; idle motion applied at draw time
        // Gather funnels the fly-source from the spread ribbon toward the single seed point
        var srcx=px+(originX-px)*state.gather, srcy=py+(originY-py)*state.gather;
        // one path, one motion: the blend's easing has zero velocity at both
        // ends, and the sheet itself decelerates to a stop as it forms (see
        // frame()) — so grains glide off a stilling surface and settle, with
        // no second mechanism needed
        var fx=srcx+(tsx-srcx)*mmi, fy=srcy+(tsy-srcy)*mmi;   // flies source → its spot as the front reaches it
        var col=(fx/cellW)|0, row=(fy/cellH)|0;
        if(col<0||col>=cols||row<0||row>=rows) continue;
        var idx=row*cols+col;
        var zz=pz*(1-mmi)+D*mmi;
        if(zz<zbuf[idx]){
          zbuf[idx]=zz;
          var diff=Math.abs(n[0]*Lx+n[1]*Ly+n[2]*Lz);
          var depth=Math.max(0.18,Math.min(1,(D+1.7-pz)/2.4));
          var rb=(0.30+0.70*diff)*depth;
          rib[idx]=rb*(1-mmi)+mmi;   // shading → solid ink as it lands
          weldBuf[idx]=wmi;          // how far the weld front has passed this cell
          // Holo only fires when the surface catches the lamp. A tight lobe on
          // the 3D normal makes that a brief flash as the ribbon turns through
          // the angle, and (1-mmi) retires it per character as it lands — so a
          // fully formed mark carries no iridescence at all.
          // direction from THIS shard to the lamp, so its distance and place in
          // space matter, not just its tilt
          var wx=LPx-pp[0], wy=LPy-pp[1], wz=LPz-pp[2];
          var wl2=Math.sqrt(wx*wx+wy*wy+wz*wz)||1; wx/=wl2; wy/=wl2; wz/=wl2;
          var hx2=wx, hy2=wy, hz2=wz-1.0;                   // + view dir (toward camera)
          var hl2=Math.sqrt(hx2*hx2+hy2*hy2+hz2*hz2)||1; hx2/=hl2; hy2/=hl2; hz2/=hl2;
          var nd=Math.abs(n[0]*hx2+n[1]*hy2+n[2]*hz2);      // two-sided sheet
          // holoWide sets the angular tolerance: tight = a rare, precise catch,
          // wide = the sheet picks up the lamp over a broader sweep
          var g2=Math.pow(nd, HOLO_EXP);
          // inverse-square falloff, so shards further from the lamp catch weaker
          glint[idx]=g2*(1.0-mmi)*(1.0/(1.0+0.10*wl2*wl2));
        }
      }
    }
  }

  // m for one infinite cycle, given seconds `c` into it. Tumble length = state.ambient.
  function cycleM(c){
    if(c<HOLD) return 1;                          // hold (float) — the seam state
    if(c<HOLD+DISS) return 1-(c-HOLD)/DISS;       // dissolve 1→0
    if(c<HOLD+DISS+state.ambient) return 0;       // ribbon tumbles (ambient time)
    return (c-(HOLD+DISS+state.ambient))/REF;     // reform 0→1 back to hold
  }
  function cycLen(){ return HOLD+DISS+state.ambient+REF; }

  var raf=0,running=false,start=0,spinAngle=0.6,lastNow=0,idlePhase=0,cyclePhase=0,loopStarted=false,chaosT=0,wAcc=0;
  var mx=-1e5,my=-1e5,pmx=-1e5,pmy=-1e5,mAmt=0,mTarget=0,dispX,dispY;  // cursor pos+prev, influence, per-grain displacement
  var lastMove=-1e9;
  sheet.addEventListener('pointermove',function(e){ var r=cv.getBoundingClientRect(); mx=e.clientX-r.left; my=e.clientY-r.top; mTarget=1; lastMove=performance.now(); });
  sheet.addEventListener('pointerleave',function(){ mTarget=0; });
  var pace=1, paceTick=0;   // >1 = render every nth frame (the lobby blurs us anyway)
  function frame(now){
    if(!running) return;
    if(pace>1){ paceTick=(paceTick+1)%pace; if(paceTick){ raf=requestAnimationFrame(frame); return; } }
    // dpr can change with NO resize event (window dragged between displays,
    // zoom) — the stale transform blows the drawing out past the bottom-right
    // corner until something rebuilds. Watch for it and rebuild ourselves.
    if(Math.min(2,window.devicePixelRatio||1)!==dpr) build();
    var dt=(now-lastNow)/1000; lastNow=now; if(dt<0)dt=0; if(dt>0.05)dt=0.05;
    idlePhase += dt*state.float/state.tempo;   // hover/ripple clock — Tempo scales it (master speed)
    chaosT += dt/state.tempo*0.8;              // swarm drift clock
    var tt=(now-start)/1000/state.tempo;
    var m;
    if(tt<SPIN) m=0;                            // intro: ribbon spins
    else if(tt<T0) m=(tt-SPIN)/RES;             // intro: forms the mark
    else if(!state.loop) m=1;                   // hold + float forever
    else {                                       // infinite loop via a phase accumulator (Ambient can change live)
      if(!loopStarted){ loopStarted=true; cyclePhase=0; }
      cyclePhase += dt/state.tempo;
      if(cyclePhase>=cycLen()){ cyclePhase-=cycLen();     // new cycle (during hold, invisible): re-roll mesh + seed
        rollMotion(); if(TN) computeStagger(state.random?rand(TN):0); }
      m=cycleM(cyclePhase);
    }
    // accumulate rotation from a per-frame delta → resets cleanly on replay, never jumps.
    // the sheet DECELERATES TO A FULL STOP as the mark forms — (1-m)² — so the
    // last grains detach from a still surface and the convergence is calm
    var sd=(1-m)*(1-m);
    spinAngle += dt*mp.rate*mp.dir*sd/state.tempo;
    // swarm intensity: eased, never detonated. The intro builds from calm
    // instead of opening at full chaos, and every loop tumble breathes in and
    // out (rising from the dissolve, settling before the reform) — at high
    // chaos dials an instant-on swarm read as the mesh exploding.
    var effChaos=state.chaos;
    if(tt<SPIN) effChaos*=smoother(tt/(SPIN*0.55));
    if(state.loop && loopStarted && cyclePhase>HOLD){
      // one breath across the whole dissolve→drift→reform span. At the span's
      // edges the mark is formed (chaos is inert there), so the envelope is
      // continuous — a window that opened mid-motion used to step the chaos
      // by 65% in a single frame, which read as the loop jumping.
      var span=DISS+state.ambient+REF;
      var tp2=(cyclePhase-HOLD)/span;
      if(tp2>0&&tp2<1) effChaos*=0.65+0.35*Math.sin(tp2*3.14159);   // a light breath, most of the range kept
      // ~1 in 3 cycles it dips near-zero mid-drift so a clean Möbius coalesces
      if(mp.showMobius && cyclePhase>HOLD+DISS && cyclePhase<HOLD+DISS+state.ambient){
        var tpm=(cyclePhase-(HOLD+DISS))/state.ambient;
        effChaos*=(1-Math.sin(tpm*3.14159)*0.92);
      }
    }
    var tilt=mp.tilt*(1-m*0.9) + Math.sin(chaosT*0.7)*0.3*effChaos*(1-m);
    var roll=mp.rz*(1-m*0.9)   + Math.cos(chaosT*0.9)*0.35*effChaos*(1-m);
    var tw = state.random ? mp.tw : state.twist;   // random mode varies the mesh per loop
    HOLO_EXP=2.0+(1.0-state.holoWide)*26.0;   // 28 = tight/rare, 2 = broad
    // The weld front runs ONLY while the mark is provably still (the hold):
    // it sweeps in across the first stretch of the hold, plateaus, and
    // sweeps back out before the dissolve is scheduled — so a welded cell
    // can never be a moving cell, and the sweep uses the morph's own
    // stagger, so it reads as the same gesture completing itself.
    var BANDf=0.14+(1-state.trail)*0.95;
    var Wn=0;
    if(reduce) Wn=1;
    else if(state.loop){
      if(loopStarted && cyclePhase<HOLD){
        var wr=HOLD*0.35;
        Wn=Math.min(cyclePhase/wr,(HOLD-cyclePhase)/wr); if(Wn>1)Wn=1; if(Wn<0)Wn=0;
      }
    } else if(m>=1){
      wAcc+=dt/(1.2*state.tempo); if(wAcc>1)wAcc=1; Wn=wAcc;
    } else wAcc=0;
    var Wp=smoother(Wn)*(1+BANDf*2.5);
    renderRibbon(spinAngle,tilt,roll,tw,m,idlePhase,effChaos,Wp);   // swarm scatters, then reflows into the strokes
    var flowT=now/1000*0.35;
    var ramp=RAMPS[state.charset], RL=ramp.length-1;
    // How much the ambient field steps back as the mark lands. At 1 the backdrop
    // is twice as bright mid-tumble as it is once formed, which reads as the whole
    // screen breathing when the canvas is fullscreen rather than a small card.
    var bgFade=1-m*0.6*state.recede;
    ctx.clearRect(0,0,W,H);
    // a hair over cell height: landed blocks touch, so the resting mark is
    // one silhouette — in motion the overlap is invisible
    ctx.font='700 '+(cellH*1.02)+'px "SF Mono", ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle=state.ink;
    // ---- holo: holodisc's grating equation, applied to the mark's characters.
    // The surface-vs-half-vector term becomes a wavelength, so colour comes out
    // of how the ribbon is turned rather than from a clock. Quantised into
    // buckets and applied only to mark cells, so it costs a handful of
    // fillStyle changes per frame instead of one per cell.
    var holo=state.holo, lastFill=state.ink;
    if(holo>0.001 && (holoCacheKey!==holo+'|'+state.ink)){
      holoCacheKey=holo+'|'+state.ink; holoCache=new Array(32768);
      var hx2=state.ink.replace('#','');
      cacheInk=[parseInt(hx2.substr(0,2),16),parseInt(hx2.substr(2,2),16),parseInt(hx2.substr(4,2),16)];
    }
    // idle motion applied HERE as continuous draw offsets → the mark floats smoothly, off the grid
    // Float = whole-shape hover (bob/drift) · Bend = how much each char warps → the shape bends/stretches
    var idle=m, RIP=cellW*0.8*state.bend;
    // cursor swipe shoves grains along the movement; Freedom lets them travel
    // further, scatter, settle looser. Velocity matters now: a fast flick
    // sweeps a wider, harder swath, and the influence stretches into a wake
    // along the direction of travel instead of a plain circle.
    if(now-lastMove>700) mTarget=0;         // idle cursor releases its hold
    mAmt += (mTarget-mAmt)*0.55;            // quicker attack
    var mvx=mx-pmx, mvy=my-pmy; pmx=mx; pmy=my;
    var spd=Math.sqrt(mvx*mvx+mvy*mvy);
    var vBoost=Math.min(1.4, spd/26);
    // a small pool of grains around the pointer, not a weather system: tight
    // base radius, modest growth from the dials and from speed
    var mR=Math.min(W,H)*0.10*(1+state.freedom*0.35);
    var mRv=mR*(1+vBoost*0.45);
    if(state.mouse>0 && mAmt>0.02 && spd>0){
      var mStr=state.mouse*0.95*mAmt*(1+vBoost*0.5), cap=mR*(0.5+state.freedom*1.1), perpAmt=state.freedom*1.7;
      var ux=mvx/spd, uy=mvy/spd;
      var ext=mRv*1.3;
      var c0=Math.max(0,((mx-ext)/cellW)|0), c1=Math.min(cols-1,((mx+ext)/cellW)|0);
      var r0=Math.max(0,((my-ext)/cellH)|0), r1=Math.min(rows-1,((my+ext)/cellH)|0);
      var aa2=mRv*mRv*1.5, bb2=mRv*mRv*0.3;    // wake ellipse: long along travel, tight across
      for(var gy2=r0;gy2<=r1;gy2++)for(var gx2=c0;gx2<=c1;gx2++){
        var mi=gy2*cols+gx2; if(rib[mi]<=0.02) continue;
        var ax=gx2*cellW+cellW*0.5-mx, ay=gy2*cellH+cellH*0.5-my;
        var dpar=ax*ux+ay*uy, dperp=ax*uy-ay*ux;
        var qq=dpar*dpar/aa2+dperp*dperp/bb2;
        if(qq<1){ var ff=1-Math.sqrt(qq); ff*=ff;
          var hh=Math.sin(mi*12.9898)*43758.5453; hh=(hh-Math.floor(hh))-0.5;   // stable per-grain scatter
          var sx=-mvy*hh*perpAmt, sy=mvx*hh*perpAmt;                             // ⊥ to the swipe → grains fan out
          var vX=dispX[mi]+(mvx+sx)*ff*mStr, vY=dispY[mi]+(mvy+sy)*ff*mStr;
          dispX[mi]=vX>cap?cap:vX<-cap?-cap:vX; dispY[mi]=vY>cap?cap:vY<-cap?-cap:vY; } }
    }
    var dcy=0.84+state.freedom*0.13;   // higher Freedom = looser, longer settle
    for(var di=0;di<dispX.length;di++){ dispX[di]*=dcy; dispY[di]*=dcy; }
    var bobY=(Math.sin(idlePhase*1.5)+Math.sin(idlePhase*0.95+1.3)*0.4)*(H*0.022)*idle;
    var driftX=(Math.sin(idlePhase*0.85)+Math.cos(idlePhase*1.4)*0.35)*(W*0.007)*idle;
    // ---- background layer: the faint glyph clouds, off by default now —
    // the paper stays one clean color unless the `field` dial brings them
    // back. When on: refreshed every 3rd frame into its own canvas (the
    // field drifts slowly, and it's ~90% of the cells at high gran).
    if(state.field>0.001){
      if(bgTick%3===0){
        bctx.clearRect(0,0,W,H);
        bctx.globalAlpha=1;
        for(var by=0;by<rows;by++){
          for(var bx2=0;bx2<cols;bx2++){
            var bidx=by*cols+bx2;
            if(rib[bidx]>0.02) continue;                 // mark cells live on the top layer
            var fluid=fbm(bx2*0.11+flowT*0.4, by*0.14 - flowT*0.2);
            var bAlpha=(0.10+fluid*0.42)*0.4*bgFade*state.field;
            if(bAlpha<0.055) continue;
            var bVal=fluid*0.72; if(bVal>1)bVal=1;
            var bci=Math.round(bVal*RL); if(bci<0)bci=0; if(bci>RL)bci=RL;
            var btile=atlas[bci]; if(!btile) continue;
            bctx.globalAlpha=bAlpha;
            bctx.drawImage(btile, bx2*cellW-2, by*cellH-2, atlasTW, atlasTH);
          }
        }
        bctx.globalAlpha=1;
      }
      bgTick++;
      ctx.drawImage(bgCv, 0, 0, W, H);
    }

    // ---- mark layer: live glyphs at true sub-pixel positions. The weld
    // level arrives per-cell from the rasteriser: a second front of the same
    // wave family, sweeping the mark in the morph's own stagger order while
    // everything is still. A welded cell fattens into a full block that
    // bleeds into its neighbours, its ripple calming as it sets.
    for(var gy=0;gy<rows;gy++){
      for(var gx=0;gx<cols;gx++){
        var idx=gy*cols+gx, ribB=rib[idx];
        if(ribB<=0.02) continue;
        var wl=weldBuf[idx];
        var hx=gx*cellW, hy=gy*cellH;
        var alpha=ribB;
        if(alpha<0.055) continue;
        var ra2=RIP*(1-wl*0.85);       // set cells stop rippling, arriving ones still do
        var dx=hx + driftX + Math.sin(idlePhase*1.3 + hx*0.026 + hy*0.02)*ra2*idle + dispX[idx];
        var dy=hy + bobY   + Math.cos(idlePhase*1.1 + hy*0.03 - hx*0.014)*ra2*0.8*idle + dispY[idx];
        var val=ribB>1?1:ribB;
        var ci=Math.round(val*RL); if(ci<0)ci=0; if(ci>RL)ci=RL;
        var ch=ramp.charAt(ci); if(ch===' ') continue;
        var tinted=false, lv=0;
        if(holo>0.001){
          var amt=holo*glint[idx];
          if(amt>0.012){
            lv=(amt*7.999/holo)|0;                // 8 strength steps, so the cache stays small
            var cc=holoColorAt(idx, lv, holo);
            if(cc!==lastFill){ ctx.fillStyle=cc; lastFill=cc; }
            tinted=true;
          } else if(lastFill!==state.ink){ ctx.fillStyle=state.ink; lastFill=state.ink; }
        }
        var a1=alpha>1?1:alpha;
        if(wl>0.01){                   // the landed block, fusing with its neighbours
          if(!tinted && lastFill!==state.ink){ ctx.fillStyle=state.ink; lastFill=state.ink; }
          ctx.globalAlpha=a1*wl;
          ctx.fillRect(dx-0.4, dy-0.4, cellW+0.8, cellH+0.8);
        }
        if(wl<0.99){                   // the glyph, easing out as its cell sets
          ctx.globalAlpha=a1*(1-wl*0.9);
          if(tinted) ctx.fillText(ch, dx, dy);
          else { var tile=atlas[ci]; if(tile) ctx.drawImage(tile, dx-2, dy-2, atlasTW, atlasTH); }
        }
        if(tinted){
          // reflection cloning: a grating repeats the catch one diffraction
          // order out on either side, dispersed by the field where the clone
          // lands — so each glint reads as a specular with two rainbow ghosts
          var rxu=hx-cx, ryu=hy-cy, rl=Math.sqrt(rxu*rxu+ryu*ryu)||1;
          var ogx=Math.round(rxu/rl*2.2), ogy=Math.round(ryu/rl*2.2);
          if(ogx||ogy){
            ctx.globalAlpha*=0.38;
            for(var od=-1;od<=1;od+=2){
              var gxg=gx+ogx*od, gyg=gy+ogy*od;
              if(gxg<0||gxg>=cols||gyg<0||gyg>=rows) continue;
              ctx.fillStyle=holoColorAt(gyg*cols+gxg, lv, holo);
              ctx.fillText(ch, dx+ogx*od*cellW, dy+ogy*od*cellH);
            }
            lastFill='';
          }
        }
      }
    }
    ctx.globalAlpha=1;
    raf=requestAnimationFrame(frame);
  }
  function play(){
    cancelAnimationFrame(raf); running=true; rollMotion(); spinAngle=mp.phase; idlePhase=0; cyclePhase=0; loopStarted=false;
    if(TN) computeStagger(state.random?rand(TN):0);
    if(reduce){ start=performance.now()-1e7; lastNow=start; state.loop=false; frame(performance.now()); running=false; return; }
    start=performance.now(); lastNow=start;
    // a page that lands in the lobby starts on the formed mark, not the intro
    if(opts.skipIntro) start-=(T0*state.tempo*1000+16);
    raf=requestAnimationFrame(frame);
  }

    // paper is the container's background showing through the cleared canvas,
    // which is how the artifact did it too — just driven by state now.
    function applyPaper() { sheet.style.background = state.paper; }

    var rt;
    function onResize() { clearTimeout(rt); rt = setTimeout(build, 150); }
    window.addEventListener('resize', onResize);

    applyPaper();
    build();
    play();

    return {
      getState: function () { return Object.assign({}, state); },
      play: play,
      setPace: function (n) { pace = Math.max(1, n | 0); paceTick = 0; },
      setState: function (patch) {
        var clean = sanitize(patch), needBuild = false, needPlay = false;
        for (var k in clean) {
          if (!Object.prototype.hasOwnProperty.call(clean, k)) continue;
          var v = clean[k];
          if (state[k] === v) continue;
          // scrubbing tempo must not jump the morph — rebase the clock instead
          if (k === 'tempo') {
            var np = performance.now();
            start = np - (np - start) * (v / state.tempo);
          }
          state[k] = v;
          // both re-rasterize the mark into the grid, so the targets must be rebuilt
          if (k === 'gran' || k === 'scale' || k === 'thin' || k === 'rotate') needBuild = true;
          else if (k === 'paper') applyPaper();
          else if (k === 'charset' || k === 'ink') buildAtlas();
          else if (k === 'loop' || k === 'random' || k === 'reveal') needPlay = true;
        }
        if (needBuild) build();
        if (needPlay) play();
      },
      destroy: function () {
        running = false;
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
      }
    };
  }

  global.createRibbon = createRibbon;
  global.RIBBON_DEFAULTS = DEFAULTS;
  global.RIBBON_RAMPS = RAMPS;
  global.ribbonSanitize = sanitize;
})(window);
