export const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const blackHoleFragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uCamPos;
uniform mat3 uCamMat;
uniform float uFovTan;

uniform float uRs;
uniform float uSpin;
uniform float uLensing;
uniform float uPhotonRing;

uniform float uDiskEnabled;
uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskThickness;
uniform float uDiskTemp;
uniform float uDoppler;
uniform float uDiskSpeed;
uniform float uDiskDetail;
uniform float uDiskBrightness;

uniform float uStarDensity;
uniform float uStarBrightness;
uniform float uNebulaIntensity;
uniform float uSkyRotation;
uniform float uQuality;

uniform sampler2D uNoiseTex;

#define PI 3.14159265359
#define TAU 6.28318530718

vec4 sampleNoise(vec2 uv) {
  return texture2D(uNoiseTex, uv);
}

float noise3D(vec3 p) {
  vec2 uvXY = p.xy + p.z * vec2(0.37, 0.73);
  vec2 uvYZ = p.yz + p.x * vec2(0.59, 0.29);
  return 0.5 * (sampleNoise(uvXY).r + sampleNoise(uvYZ).g);
}

float fbm3D(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  mat3 rot = mat3(
     0.80,  0.48, -0.36,
    -0.48,  0.84,  0.25,
     0.36,  0.25,  0.90
  );
  for (int i = 0; i < 3; i++) {
    v += a * noise3D(p);
    p = rot * p * 2.02 + vec3(0.19, 0.37, 0.51);
    a *= 0.5;
  }
  return v;
}

float fbmDetail(vec2 p, float detail) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.866, 0.5, -0.5, 0.866);
  for (int i = 0; i < 4; i++) {
    vec4 n = sampleNoise(p);
    float layer = mix(n.r, n.g, 0.45);
    v += a * layer;
    p = rot * p * (1.95 + 0.14 * detail) + vec2(0.23, 0.41);
    a *= 0.51;
  }
  return v;
}

vec3 blackbodyColor(float tempK) {
  float t = clamp(tempK, 1200.0, 24000.0) / 100.0;
  vec3 col;

  if (t <= 66.0) {
    col.r = 1.0;
    col.g = clamp(0.39008157 * log(max(t, 1.0)) - 0.63184144, 0.0, 1.0);
  } else {
    col.r = clamp(1.29293618 * pow(t - 60.0, -0.13320475), 0.0, 1.0);
    col.g = clamp(1.12989086 * pow(t - 60.0, -0.07551484), 0.0, 1.0);
  }

  if (t >= 66.0) {
    col.b = 1.0;
    float blueBoost = smoothstep(70.0, 130.0, t);
    col.r *= mix(1.0, 0.62, blueBoost);
    col.g *= mix(1.0, 0.80, blueBoost);
  } else if (t <= 19.0) {
    col.b = 0.0;
  } else {
    col.b = clamp(0.54320678 * log(t - 10.0) - 1.19625408, 0.0, 1.0);
  }

  return pow(col, vec3(1.32));
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p.zxy, p.yxz + 19.27);
  return fract(vec3(p.x * p.y, p.z * p.x, p.y * p.z));
}

// Equi-angular cubed-sphere projection: maps unit vector d on S^2 to (faceUv.xy, faceId)
// with zero pole singularities and zero 3D-lattice slicing rings.
vec3 dirToCubedSphere(vec3 d) {
  vec3 ad = abs(d);
  float faceId;
  vec2 sc;
  float ma;

  if (ad.x >= ad.y && ad.x >= ad.z) {
    ma = ad.x;
    sc = d.x > 0.0 ? vec2(-d.z, d.y) : vec2(d.z, d.y);
    faceId = d.x > 0.0 ? 0.0 : 1.0;
  } else if (ad.y >= ad.x && ad.y >= ad.z) {
    ma = ad.y;
    sc = d.y > 0.0 ? vec2(d.x, -d.z) : vec2(d.x, d.z);
    faceId = d.y > 0.0 ? 2.0 : 3.0;
  } else {
    ma = ad.z;
    sc = d.z > 0.0 ? vec2(d.x, d.y) : vec2(-d.x, d.y);
    faceId = d.z > 0.0 ? 4.0 : 5.0;
  }

  vec2 uv = (2.0 / PI) * atan(sc / max(ma, 1e-6));
  return vec3(uv * 0.5 + 0.5, faceId);
}

vec3 evalStarLayer(vec3 cs, float scale, float densityThreshold, float sizeScale, float seedOffset) {
  vec2 gridCoord = cs.xy * scale;
  vec2 i = floor(gridCoord);
  vec2 f = fract(gridCoord);

  vec3 rnd = hash33(vec3(i, cs.z + seedOffset));
  if (rnd.z > densityThreshold) return vec3(0.0);

  vec2 starCenter = 0.20 + 0.60 * rnd.xy;
  vec2 diff = f - starCenter;
  float dist2 = dot(diff, diff);

  float radius = sizeScale * (0.42 + 0.58 * rnd.x);
  float core = exp(-dist2 / max(radius * radius * 0.14, 1e-6));
  float halo = 0.25 * exp(-dist2 / max(radius * radius * 1.65, 1e-5));

  float temp = mix(3000.0, 17500.0, pow(rnd.y, 1.25));
  vec3 starCol = blackbodyColor(temp);
  float lum = pow(rnd.x, 1.85) * (0.45 + 2.5 * pow(rnd.z / max(densityThreshold, 1e-4), 3.0));

  return starCol * (core + halo) * lum;
}

vec3 evalBackgroundSky(vec3 dir, float deflection, float minR, float rPh) {
  float cRot = cos(uSkyRotation);
  float sRot = sin(uSkyRotation);
  vec3 d = vec3(
    cRot * dir.x + sRot * dir.z,
    dir.y,
    -sRot * dir.x + cRot * dir.z
  );

  mat3 galTilt = mat3(
    0.866, -0.354, 0.354,
    0.400,  0.900, -0.150,
   -0.300,  0.250, 0.920
  );
  vec3 gd = normalize(galTilt * d);

  float galBand = exp(-pow(gd.y * 3.6, 2.0));
  float galCore = exp(-pow(gd.y * 5.2, 2.0)) * exp(-pow((gd.x - 0.35) * 1.5, 2.0));

  float n1 = fbm3D(gd * 1.35);
  float n2 = fbm3D(gd * 2.9 + vec3(n1 * 0.42, -n1 * 0.32, n1 * 0.24));
  float dustLane = smoothstep(0.40, 0.68, fbm3D(gd * 2.15 + vec3(0.31, 0.67, 0.13)));

  vec3 nebulaWarm = vec3(0.88, 0.48, 0.22) * pow(n1, 1.4) * (0.35 * galBand + 0.65 * galCore) * 0.55;
  vec3 nebulaCool = vec3(0.14, 0.26, 0.52) * pow(n2, 1.3) * galBand * 0.35;
  vec3 deepSpaceAmbient = vec3(0.005, 0.007, 0.012);
  vec3 nebula = (nebulaWarm + nebulaCool) * (1.0 - 0.72 * dustLane * galBand) * uNebulaIntensity + deepSpaceAmbient;

  float dens = clamp(uStarDensity, 0.05, 3.0);
  float mwBoost = 1.0 + 1.35 * galBand;

  vec3 cs1 = dirToCubedSphere(gd);
  mat3 starRot2 = mat3(
     0.60,  0.48,  0.64,
    -0.80,  0.36,  0.48,
     0.00, -0.80,  0.60
  );
  vec3 cs2 = dirToCubedSphere(starRot2 * gd);

  vec3 stars = vec3(0.0);
  stars += evalStarLayer(cs1, 68.0,  0.075 * dens, 0.105, 0.0) * 2.6;
  stars += evalStarLayer(cs2, 135.0, 0.150 * dens * mwBoost, 0.095, 17.0) * 1.4;
  stars += evalStarLayer(cs1, 230.0, 0.260 * dens * mwBoost, 0.088, 43.0) * 0.85;
  stars += evalStarLayer(cs2, 360.0, 0.380 * dens * mwBoost, 0.080, 89.0) * 0.48;

  float einsteinBoost = 1.0 + uLensing * 1.85 * exp(-max(minR - rPh, 0.0) / max(0.35 * uRs, 0.05)) * smoothstep(0.12, 1.3, deflection);
  stars *= uStarBrightness * einsteinBoost;

  return nebula + stars;
}

vec4 evaluateAccretionDisk(vec3 pos, vec3 rayDir, float r, float rIn, float rOut, float layerWeight) {
  float radialNorm = (r - rIn) / max(rOut - rIn, 0.001);
  if (radialNorm <= 0.0 || radialNorm >= 1.0) return vec4(0.0);

  float innerEdge = smoothstep(0.0, 0.075, radialNorm);
  float outerEdge = pow(clamp(1.0 - radialNorm, 0.0, 1.0), 2.15);
  float ntDecay = pow(rIn / max(r, rIn), 1.95);
  float radialProfile = innerEdge * outerEdge * mix(ntDecay, outerEdge, 0.35) * 1.45;

  float omega = 1.7 / (pow(max(r / uRs, 0.8), 1.5) + 0.25 * uSpin);
  float rotTime = uTime * uDiskSpeed * 0.52;

  float phase0 = fract(rotTime * 0.16);
  float phase1 = fract(rotTime * 0.16 + 0.5);
  float phaseBlend = smoothstep(0.0, 1.0, abs(2.0 * phase0 - 1.0));

  float baseRot = rotTime * 0.85;
  float angle0 = baseRot + (phase0 - 0.5) * 3.8 * omega;
  float angle1 = baseRot + (phase1 - 0.5) * 3.8 * omega;

  vec2 xz = pos.xz / max(uRs, 0.01);
  vec2 dirXZ = xz / max(length(xz), 1e-4);

  float c0 = cos(angle0), s0 = sin(angle0);
  float c1 = cos(angle1), s1 = sin(angle1);
  vec2 rotXZ0 = vec2(c0 * dirXZ.x - s0 * dirXZ.y, s0 * dirXZ.x + c0 * dirXZ.y);
  vec2 rotXZ1 = vec2(c1 * dirXZ.x - s1 * dirXZ.y, s1 * dirXZ.x + c1 * dirXZ.y);

  float logR = log(max(r / rIn, 1.0));
  float detailScale = 0.65 + 0.75 * uDiskDetail;

  vec2 uv0 = rotXZ0 * (0.32 + 0.52 * logR) * detailScale;
  vec2 uv1 = rotXZ1 * (0.32 + 0.52 * logR) * detailScale;

  float turb0 = fbmDetail(uv0 + vec2(logR * 2.1, 0.0), uDiskDetail);
  float turb1 = fbmDetail(uv1 + vec2(logR * 2.1, 0.43), uDiskDetail);
  float spiralTurb = mix(turb0, turb1, phaseBlend);

  float ringFade = 1.0 - smoothstep(0.25, 0.85, radialNorm);
  float ringFreq = (13.0 + 18.0 * uDiskDetail) * logR;
  float ringNoise0 = sampleNoise(vec2(logR * 3.5 * detailScale, 0.15) + rotXZ0 * 0.16).g;
  float ringNoise1 = sampleNoise(vec2(logR * 3.5 * detailScale, 0.65) + rotXZ1 * 0.16).g;
  float ringMod = mix(ringNoise0, ringNoise1, phaseBlend);

  float concentricRings = 0.52 + 0.48 * sin(ringFreq + spiralTurb * 5.2);
  float fineRings = 0.58 + 0.42 * sin(ringFreq * 2.6 - ringMod * 6.0);
  float microStreaks = mix(1.0, 0.72 + 0.28 * sin(ringFreq * 4.8 + spiralTurb * 8.5), ringFade);
  float ringStructure = mix(0.72, concentricRings * fineRings * microStreaks, (0.55 + 0.35 * ringFade) * clamp(uDiskDetail, 0.2, 1.5));
  float filaments = (0.42 + 1.18 * spiralTurb) * ringStructure;

  float gap1 = 1.0 - 0.52 * ringFade * exp(-pow((radialNorm - 0.18) / 0.026, 2.0));
  float gap2 = 1.0 - 0.40 * ringFade * exp(-pow((radialNorm - 0.39) / 0.035, 2.0));
  float density = radialProfile * filaments * gap1 * gap2;
  density = clamp(density * 1.95, 0.0, 2.4);

  vec3 tangent = normalize(vec3(-pos.z, 0.0, pos.x));
  float beta = clamp(sqrt(0.5 * uRs / max(r - 0.5 * uRs, 0.35 * uRs)), 0.0, 0.78);
  float cosTheta = dot(-rayDir, tangent);
  float gamma = inversesqrt(max(1.0 - beta * beta, 0.15));
  float dopplerPhys = 1.0 / (gamma * (1.0 - beta * cosTheta));
  float doppler = mix(1.0, dopplerPhys, uDoppler);

  float gravRedshift = sqrt(clamp(1.0 - 0.85 * uRs / max(r, 1.05 * uRs), 0.18, 1.0));

  float radialTempFactor = pow(clamp(1.0 - radialNorm * 0.82, 0.12, 1.0), 0.64);
  float localTemp = uDiskTemp * radialTempFactor * pow(max(doppler, 0.3), 0.52) * (0.78 + 0.42 * ringStructure);

  vec3 bbCol = blackbodyColor(localTemp);
  vec3 outerCrimsonGold = vec3(0.88, 0.18, 0.01);
  vec3 midAmberGold = vec3(1.0, 0.48, 0.07);
  vec3 innerWarmWhite = vec3(1.0, 0.86, 0.52);
  float coreMix = pow(clamp(1.0 - radialNorm * 0.85, 0.0, 1.0), 1.05) * (0.55 + 0.45 * ringStructure);
  vec3 goldCinema = mix(outerCrimsonGold, midAmberGold, smoothstep(0.0, 0.58, coreMix));
  goldCinema = mix(goldCinema, innerWarmWhite, smoothstep(0.52, 0.98, coreMix));

  float tempBlend = smoothstep(3200.0, 6200.0, uDiskTemp) * (1.0 - smoothstep(6200.0, 10500.0, uDiskTemp));
  vec3 baseCol = mix(bbCol, mix(bbCol, goldCinema, 0.82), tempBlend * (1.0 - 0.30 * clamp(uDoppler, 0.0, 1.0)));

  float beamingBoost = pow(clamp(doppler, 0.28, 2.05), 2.05);
  float iscoGlow = 1.0 + 1.15 * exp(-max(radialNorm - 0.015, 0.0) / 0.075) * ringStructure;

  vec3 rawEmission = baseCol * density * beamingBoost * gravRedshift * iscoGlow * uDiskBrightness;
  float maxCh = max(rawEmission.r, max(rawEmission.g, rawEmission.b));
  vec3 compressedEmission = rawEmission / (1.0 + 0.32 * maxCh);

  vec3 emission = compressedEmission * layerWeight;
  float alpha = clamp(density * 0.84 * layerWeight, 0.0, 0.95);

  return vec4(emission, alpha);
}

vec4 evaluateVolumetricCorona(vec3 pos, vec3 rayDir, float r, float rIn, float rOut, float slabIntegral) {
  float radialNorm = (r - rIn) / max(rOut - rIn, 0.001);
  if (radialNorm <= 0.0 || radialNorm >= 0.98) return vec4(0.0);

  float innerEdge = smoothstep(0.0, 0.08, radialNorm);
  float outerEdge = pow(clamp(1.0 - radialNorm, 0.0, 1.0), 2.4);
  float ntDecay = pow(rIn / max(r, rIn), 2.1);
  float radialProfile = innerEdge * outerEdge * ntDecay;

  vec3 tangent = normalize(vec3(-pos.z, 0.0, pos.x));
  float beta = clamp(sqrt(0.5 * uRs / max(r - 0.5 * uRs, 0.35 * uRs)), 0.0, 0.75);
  float cosTheta = dot(-rayDir, tangent);
  float gamma = inversesqrt(max(1.0 - beta * beta, 0.18));
  float doppler = mix(1.0, 1.0 / (gamma * (1.0 - beta * cosTheta)), uDoppler);

  float radialTempFactor = pow(clamp(1.0 - radialNorm * 0.78, 0.14, 1.0), 0.62);
  vec3 col = blackbodyColor(uDiskTemp * 0.82 * radialTempFactor * pow(max(doppler, 0.35), 0.5));
  col = mix(col, vec3(1.0, 0.50, 0.12), 0.42 * smoothstep(3200.0, 6500.0, uDiskTemp) * (1.0 - smoothstep(6500.0, 10500.0, uDiskTemp)));
  float boost = pow(clamp(doppler, 0.3, 2.0), 2.0) * uDiskBrightness;

  float dens = radialProfile * slabIntegral;
  vec3 emission = col * dens * boost * 0.85;
  return vec4(emission / (1.0 + 0.3 * max(emission.r, emission.g)), clamp(dens * 0.42, 0.0, 0.45));
}

float segmentSphereHit(vec3 p0, vec3 p1, float radius) {
  vec3 d = p1 - p0;
  float a = dot(d, d);
  if (a < 1e-8) return length(p0) <= radius ? 0.0 : 2.0;
  float b = 2.0 * dot(p0, d);
  float c = dot(p0, p0) - radius * radius;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return 2.0;
  float sqrtDisc = sqrt(disc);
  float t1 = (-b - sqrtDisc) / (2.0 * a);
  float t2 = (-b + sqrtDisc) / (2.0 * a);
  if (t1 >= 0.0 && t1 <= 1.0) return t1;
  if (t2 >= 0.0 && t2 <= 1.0) return t2;
  return 2.0;
}

void main() {
  vec2 ndc = (vUv * 2.0 - 1.0);
  ndc.x *= uResolution.x / max(uResolution.y, 1.0);

  vec3 rayDir = normalize(uCamMat * normalize(vec3(ndc * uFovTan, -1.0)));
  vec3 pos = uCamPos;

  float rPh = uRs * (1.5 - 0.10 * uSpin);
  float rHorizon = rPh * 0.985;
  float rIn = uRs * max(uDiskInner * 0.60 * (1.0 - 0.12 * uSpin), 1.68);
  float rOut = uRs * max(uDiskOuter, uDiskInner + 2.5);
  vec3 camDirFromOrigin = normalize(uCamPos);

  vec3 accumCol = vec3(0.0);
  float transmittance = 1.0;
  vec3 fgCol = vec3(0.0);
  float fgTrans = 1.0;

  float minR = 1e5;
  float photonRingAccum = 0.0;
  bool captured = false;
  vec3 initDir = rayDir;

  float maxDist = max(length(uCamPos) * 2.2, rOut * 2.5);
  int maxSteps = int(mix(85.0, 140.0, clamp(uQuality, 0.0, 1.0)));

  vec3 spinAxis = vec3(0.0, 1.0, 0.0);

  for (int i = 0; i < 140; i++) {
    if (i >= maxSteps) break;

    float r = length(pos);
    minR = min(minR, r);

    if (r <= rHorizon * 1.002) {
      captured = true;
      break;
    }
    if (r > maxDist && dot(pos, rayDir) > 0.0) {
      break;
    }

    vec3 hVec = cross(pos, rayDir);
    float h2 = dot(hVec, hVec);

    float distFromHorizon = max(r - rHorizon * 0.88, 0.03 * uRs);
    float dt = clamp(distFromHorizon * 0.135 + 0.0045 * (r * r / max(uRs, 0.1)), 0.025 * uRs, 1.45 * uRs);

    float r2 = r * r;
    float r3 = r2 * r;
    float r5 = r2 * r3;
    vec3 accelGR = -1.5 * uLensing * uRs * h2 * pos / max(r5, 1e-5);
    vec3 accelKerr = uLensing * 0.85 * uSpin * (uRs * uRs * uRs / max(r5, 1e-5)) * cross(rayDir, spinAxis);
    vec3 accel = accelGR + accelKerr;

    vec3 midVel = normalize(rayDir + 0.5 * accel * dt);
    vec3 nextPos = pos + midVel * dt;
    vec3 nextDir = normalize(rayDir + accel * dt);

    float hitT = segmentSphereHit(pos, nextPos, rHorizon * 1.004);
    float nextR = length(nextPos);
    bool stepHitHorizon = (hitT <= 1.0) || (nextR <= rHorizon * 1.004);
    float maxValidFrac = stepHitHorizon ? clamp(hitT, 0.0, 1.0) : 1.0;

    float phDist = abs(r - rPh) / max(uRs, 0.01);
    photonRingAccum += exp(-phDist * phDist * 22.0) * (dt / max(uRs, 0.01)) * transmittance;

    if (uDiskEnabled > 0.5) {
      if (pos.y * nextPos.y <= 0.0) {
        float frac = clamp(-pos.y / (nextPos.y - pos.y + 1e-7), 0.0, 1.0);
        if (frac <= maxValidFrac) {
          vec3 hitPos = mix(pos, nextPos, frac);
          vec3 hitDir = normalize(mix(rayDir, nextDir, frac));
          float hitR = length(hitPos.xz);

          if (hitR >= rIn && hitR <= rOut * 1.06) {
            float grazeBoost = clamp(1.0 / max(abs(hitDir.y) + 0.35, 0.35), 0.85, 1.85);
            float thickBoost = 0.68 + 0.45 * uDiskThickness;
            vec4 diskSample = evaluateAccretionDisk(hitPos, hitDir, hitR, rIn, rOut, grazeBoost * thickBoost);
            accumCol += transmittance * diskSample.rgb;
            transmittance *= (1.0 - diskSample.a);

            float frontProj = dot(hitPos, camDirFromOrigin);
            float fgMask = smoothstep(-0.05 * uRs, 0.35 * uRs, frontProj) * smoothstep(2.12 * uRs, 2.42 * uRs, hitR);
            fgCol += fgTrans * diskSample.rgb * fgMask;
            fgTrans *= (1.0 - diskSample.a * fgMask);
          }
        }
      }

      if (!stepHitHorizon && uDiskThickness > 0.03) {
        float sClosest = clamp(-pos.y / (nextPos.y - pos.y + 1e-7), 0.0, 1.0);
        vec3 closestPos = mix(pos, nextPos, sClosest);
        float cylR = length(closestPos.xz);
        if (cylR >= rIn && cylR < rOut * 0.98) {
          float radialFrac = clamp((cylR - rIn) / max(rOut - rIn, 0.01), 0.0, 1.0);
          float halfH = uRs * uDiskThickness * (0.20 + 0.80 * pow(radialFrac, 0.85));
          float y0 = pos.y / max(halfH, 1e-4);
          float y1 = nextPos.y / max(halfH, 1e-4);
          if (min(abs(y0), abs(y1)) < 2.5 || (y0 * y1 <= 0.0)) {
            float cdf0 = y0 * inversesqrt(1.0 + y0 * y0);
            float cdf1 = y1 * inversesqrt(1.0 + y1 * y1);
            float slabDiff = abs(cdf1 - cdf0);
            float graze = clamp(1.0 / max(abs(midVel.y) + 0.38, 0.38), 0.7, 1.6);
            float slabIntegral = slabDiff * graze * (0.35 + 0.85 * uDiskThickness);
            vec4 volSample = evaluateVolumetricCorona(closestPos, midVel, cylR, rIn, rOut, slabIntegral);
            accumCol += transmittance * volSample.rgb;
            transmittance *= (1.0 - volSample.a);

            float frontProj = dot(closestPos, camDirFromOrigin);
            float fgMask = smoothstep(-0.05 * uRs, 0.35 * uRs, frontProj) * smoothstep(2.12 * uRs, 2.42 * uRs, cylR);
            fgCol += fgTrans * volSample.rgb * fgMask;
            fgTrans *= (1.0 - volSample.a * fgMask);
          }
        }
      }
    }

    if (stepHitHorizon) {
      captured = true;
      break;
    }

    if (transmittance < 0.012) break;

    pos = nextPos;
    rayDir = nextDir;
  }

  float ringDist = abs(minR - rPh) / max(uRs, 0.01);
  float thinPhotonRing = exp(-ringDist * 30.0) * smoothstep(rHorizon * 0.99, rPh * 1.03, minR);
  float multiOrbitRing = pow(clamp(photonRingAccum * 0.34, 0.0, 1.6), 1.75);

  vec3 ringTint = blackbodyColor(clamp(uDiskTemp * 1.15, 3600.0, 16000.0));
  float ringAsym = 1.0 + 0.42 * uDoppler * clamp(dot(normalize(cross(uCamPos, vec3(0.0, 1.0, 0.0))), rayDir) * 2.0, -0.65, 0.85);
  vec3 photonGlow = ringTint * (thinPhotonRing * 1.35 + multiOrbitRing * 0.78) * uPhotonRing * ringAsym;

  if (!captured) {
    float skyLensEnvelope = exp(-pow(max(minR - rPh * 1.05, 0.0) / max(1.55 * uRs, 0.1), 2.0));
    vec3 skyDir = normalize(mix(initDir, rayDir, clamp(0.62 * skyLensEnvelope, 0.0, 0.85)));
    float deflection = acos(clamp(dot(initDir, skyDir), -1.0, 1.0));
    vec3 skyCol = evalBackgroundSky(skyDir, deflection, minR, rPh);
    accumCol += transmittance * skyCol;
    accumCol += photonGlow * (0.42 + 0.58 * transmittance);
  } else {
    accumCol = fgCol;
    transmittance = fgTrans;
  }

  float shadowKeep = captured ? (1.0 - transmittance) : 1.0;
  gl_FragColor = vec4(max(accumCol, vec3(0.0)), shadowKeep);
}
`;

export const bloomExtractShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uThreshold;

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float knee = uThreshold * 0.55;
  float soft = lum - uThreshold + knee;
  soft = clamp(soft, 0.0, 2.0 * knee);
  soft = soft * soft / max(4.0 * knee, 1e-4);
  float contrib = max(soft, lum - uThreshold) / max(lum, 1e-4);
  gl_FragColor = vec4(col * max(contrib, 0.0), 1.0);
}
`;

export const bloomBlurShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDirection;
uniform vec2 uTexelSize;

void main() {
  vec2 off1 = vec2(1.3846153846) * uDirection * uTexelSize;
  vec2 off2 = vec2(3.2307692308) * uDirection * uTexelSize;
  vec2 off3 = vec2(5.0769230769) * uDirection * uTexelSize;

  vec3 result = texture2D(tDiffuse, vUv).rgb * 0.214607;
  result += texture2D(tDiffuse, vUv + off1).rgb * 0.289026;
  result += texture2D(tDiffuse, vUv - off1).rgb * 0.289026;
  result += texture2D(tDiffuse, vUv + off2).rgb * 0.088269;
  result += texture2D(tDiffuse, vUv - off2).rgb * 0.088269;
  result += texture2D(tDiffuse, vUv + off3).rgb * 0.0154015;
  result += texture2D(tDiffuse, vUv - off3).rgb * 0.0154015;

  gl_FragColor = vec4(result, 1.0);
}
`;

export const compositeFragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloomWide;
uniform sampler2D tBloomAnamorphic;

uniform float uBloomStrength;
uniform float uAnamorphicStrength;
uniform float uExposure;
uniform float uTime;

vec3 acesToneMap(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 centerOffset = vUv - 0.5;
  float distFromCenter = length(centerOffset);

  vec2 caOffset = centerOffset * 0.0014 * smoothstep(0.18, 0.75, distFromCenter);
  vec4 sceneCenter = texture2D(tScene, vUv);
  vec3 sceneCol;
  sceneCol.r = texture2D(tScene, vUv + caOffset).r;
  sceneCol.g = sceneCenter.g;
  sceneCol.b = texture2D(tScene, vUv - caOffset).b;

  float shadowMask = mix(0.28, 1.0, smoothstep(0.0, 0.35, sceneCenter.a));

  vec3 bloomWide = texture2D(tBloomWide, vUv).rgb * shadowMask;
  vec3 bloomAna = texture2D(tBloomAnamorphic, vUv).rgb * mix(0.55, 1.0, shadowMask);

  vec3 anamorphicTint = mix(bloomAna, bloomAna * vec3(0.88, 0.94, 1.18), 0.35);

  vec3 hdr = sceneCol
    + bloomWide * uBloomStrength
    + anamorphicTint * uAnamorphicStrength;

  hdr *= uExposure;

  vec3 perChannel = acesToneMap(hdr);
  float maxC = max(hdr.r, max(hdr.g, hdr.b));
  float mappedMax = acesToneMap(vec3(maxC)).r;
  vec3 huePreserving = hdr * (mappedMax / max(maxC, 1e-4));
  vec3 mapped = mix(huePreserving, perChannel, 0.24);
  mapped = pow(mapped, vec3(1.0 / 2.2));

  float vignette = 1.0 - 0.32 * pow(distFromCenter * 1.25, 2.2);
  mapped *= clamp(vignette, 0.38, 1.0);

  float grain = fract(sin(dot(vUv * 512.0 + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453);
  mapped += (grain - 0.5) * (0.7 / 255.0);

  gl_FragColor = vec4(mapped, 1.0);
}
`;
