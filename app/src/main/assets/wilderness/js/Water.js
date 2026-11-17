( function () {

	/**
 * Work based on :
 * http://slayvin.net : Flat mirror for three.js
 * http://www.adelphi.edu/~stemkoski : An implementation of water shader based on the flat mirror
 * http://29a.ch/ && http://29a.ch/slides/2012/webglwater/ : Water shader explanations in WebGL
 */

	class Water extends THREE.Mesh {

		constructor( geometry, options = {} ) {

			super( geometry );
			const scope = this;
			const textureWidth = options.textureWidth !== undefined ? options.textureWidth : 512;
			const textureHeight = options.textureHeight !== undefined ? options.textureHeight : 512;
			const clipBias = options.clipBias !== undefined ? options.clipBias : 0.0;
			const alpha = options.alpha !== undefined ? options.alpha : 1.0;
			const time = options.time !== undefined ? options.time : 0.0;
			const normalSampler = options.waterNormals !== undefined ? options.waterNormals : null;
			const sunDirection = options.sunDirection !== undefined ? options.sunDirection : new THREE.Vector3( 0.70707, 0.70707, 0.0 );
			const sunColor = new THREE.Color( options.sunColor !== undefined ? options.sunColor : 0xffffff );
			const waterColor = new THREE.Color( options.waterColor !== undefined ? options.waterColor : 0x7F7F7F );
			const eye = options.eye !== undefined ? options.eye : new THREE.Vector3( 0, 0, 0 );
			const distortionScale = options.distortionScale !== undefined ? options.distortionScale : 20.0;
			const side = options.side !== undefined ? options.side : THREE.DoubleSide;
			const fog = options.fog !== undefined ? options.fog : false; //

			const mirrorPlane = new THREE.Plane();
			const normal = new THREE.Vector3();
			const mirrorWorldPosition = new THREE.Vector3();
			const cameraWorldPosition = new THREE.Vector3();
			const rotationMatrix = new THREE.Matrix4();
			const lookAtPosition = new THREE.Vector3( 0, 0, - 1 );
			const clipPlane = new THREE.Vector4();
			const view = new THREE.Vector3();
			const target = new THREE.Vector3();
			const q = new THREE.Vector4();
			const textureMatrix = new THREE.Matrix4();
			const mirrorCamera = new THREE.PerspectiveCamera();
			const parameters = {
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				format: THREE.RGBAFormat
			};
			const renderTarget = new THREE.WebGLRenderTarget( textureWidth, textureHeight, parameters );

			if ( ! THREE.MathUtils.isPowerOfTwo( textureWidth ) || ! THREE.MathUtils.isPowerOfTwo( textureHeight ) ) {

				renderTarget.texture.generateMipmaps = false;

			}

			const mirrorShader = {
				uniforms: THREE.UniformsUtils.merge( [ THREE.UniformsLib[ 'fog' ], THREE.UniformsLib[ 'lights' ], {
					'normalSampler': {
						value: null
					},
					'mirrorSampler': {
						value: null
					},
					'alpha': {
						value: 1.0
					},
					'time': {
						value: 0.0
					},
					'size': {
						value: 1.0
					},
					'distortionScale': {
						value: 20.0
					},
					'textureMatrix': {
						value: new THREE.Matrix4()
					},
					'sunColor': {
						value: new THREE.Color( 0x7F7F7F )
					},
					'sunDirection': {
						value: new THREE.Vector3( 0.70707, 0.70707, 0 )
					},
					'eye': {
						value: new THREE.Vector3()
					},
					'waterColor': {
						value: new THREE.Color( 0x555555 )
					},
					'uRipples': {
						value: [
							new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
							new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()
						]
					},
					'uRainIntensity': {
						value: 0.0
					},
					'uFoamIntensity': {
						value: 0.4
					},
					'uWaveAmp': {
						value: 1.0
					}
				} ] ),
				vertexShader:
      /* glsl */
      `
				attribute float aWaterDepth;

				uniform mat4 textureMatrix;
				uniform float time;
				uniform float uWaveAmp;

				varying vec4 mirrorCoord;
				varying vec4 worldPosition;
				varying float vWaveHeight;
				varying vec2 vWaveSlope;
				varying float vWaterDepth;

				#include <common>
				#include <fog_pars_vertex>
				#include <shadowmap_pars_vertex>
				#include <logdepthbuf_pars_vertex>

				void main() {
					vec4 baseWorld = modelMatrix * vec4( position, 1.0 );
					float wx = baseWorld.x;
					float wz = baseWorld.z;

					// Smoothly swell from lively river/bay chop into rolling 3D ocean waves north of z = -35
					// Calm wave vertical displacement smoothly near shallow shorelines so water never slices abruptly into banks
					float oceanMix = clamp( ( -35.0 - wz ) / 45.0, 0.0, 1.0 );
					float shoreCalm = smoothstep( 0.0, 0.95, aWaterDepth );
					float amp = ( 0.36 + oceanMix * 1.38 ) * uWaveAmp * shoreCalm;

					float p1 = wx * 0.075 + wz * 0.055 + time * 1.65;
					float p2 = wx * -0.048 + wz * 0.105 + time * 2.15;
					float p3 = wx * 0.14 - wz * 0.12 + time * 2.85;
					float p4 = wx * 0.24 + wz * 0.20 - time * 3.40;

					float waveY = ( sin( p1 ) * 0.48 + sin( p2 ) * 0.32 + cos( p3 ) * 0.14 + sin( p4 ) * 0.06 ) * amp;

					// Analytical slope for 3D wave normal tilting
					float dwdx = ( cos( p1 ) * 0.075 * 0.48 + cos( p2 ) * -0.048 * 0.32 - sin( p3 ) * 0.14 * 0.14 + cos( p4 ) * 0.24 * 0.06 ) * amp;
					float dwdz = ( cos( p1 ) * 0.055 * 0.48 + cos( p2 ) * 0.105 * 0.32 + sin( p3 ) * 0.12 * 0.14 + cos( p4 ) * 0.20 * 0.06 ) * amp;

					vWaveHeight = waveY;
					vWaveSlope = vec2( dwdx, dwdz );
					vWaterDepth = aWaterDepth;

					// PlaneGeometry is rotated -90 deg around X, so local +Z maps to world +Y (vertical height)
					vec3 displaced = vec3( position.x, position.y, position.z + waveY );

					mirrorCoord = modelMatrix * vec4( displaced, 1.0 );
					worldPosition = mirrorCoord.xyzw;
					mirrorCoord = textureMatrix * mirrorCoord;
					vec4 mvPosition = modelViewMatrix * vec4( displaced, 1.0 );
					gl_Position = projectionMatrix * mvPosition;

				#include <beginnormal_vertex>
				#include <defaultnormal_vertex>
				#include <logdepthbuf_vertex>
				#include <fog_vertex>
				#include <shadowmap_vertex>
			}`,
				fragmentShader:
      /* glsl */
      `
				uniform sampler2D mirrorSampler;
				uniform float alpha;
				uniform float time;
				uniform float size;
				uniform float distortionScale;
				uniform sampler2D normalSampler;
				uniform vec3 sunColor;
				uniform vec3 sunDirection;
				uniform vec3 eye;
				uniform vec3 waterColor;
				uniform vec4 uRipples[8];
				uniform float uRainIntensity;
				uniform float uFoamIntensity;

				varying vec4 mirrorCoord;
				varying vec4 worldPosition;
				varying float vWaveHeight;
				varying vec2 vWaveSlope;
				varying float vWaterDepth;

				vec4 getNoise( vec2 uv ) {
					vec2 uv0 = ( uv / 103.0 ) + vec2(time / 17.0, time / 29.0);
					vec2 uv1 = uv / 107.0-vec2( time / -19.0, time / 31.0 );
					vec2 uv2 = uv / vec2( 8907.0, 9803.0 ) + vec2( time / 101.0, time / 97.0 );
					vec2 uv3 = uv / vec2( 1091.0, 1027.0 ) - vec2( time / 109.0, time / -113.0 );
					vec4 noise = texture2D( normalSampler, uv0 ) +
						texture2D( normalSampler, uv1 ) +
						texture2D( normalSampler, uv2 ) +
						texture2D( normalSampler, uv3 );
					return noise * 0.5 - 1.0;
				}

				vec4 getNoiseFar( vec2 uv ) {
					vec2 uv0 = ( uv / 103.0 ) + vec2(time / 17.0, time / 29.0);
					vec2 uv2 = uv / vec2( 8907.0, 9803.0 ) + vec2( time / 101.0, time / 97.0 );
					vec4 noise = ( texture2D( normalSampler, uv0 ) + texture2D( normalSampler, uv2 ) ) * 2.0;
					return noise * 0.5 - 1.0;
				}

				void sunLight( const vec3 surfaceNormal, const vec3 eyeDirection, float shiny, float spec, float diffuse, inout vec3 diffuseColor, inout vec3 specularColor ) {
					vec3 reflection = normalize( reflect( -sunDirection, surfaceNormal ) );
					float direction = max( 0.0, dot( eyeDirection, reflection ) );
					specularColor += pow( direction, shiny ) * sunColor * spec;
					diffuseColor += max( dot( sunDirection, surfaceNormal ), 0.0 ) * sunColor * diffuse;
				}

				#include <common>
				#include <packing>
				#include <bsdfs>
				#include <fog_pars_fragment>
				#include <logdepthbuf_pars_fragment>
				#include <lights_pars_begin>
				#include <shadowmap_pars_fragment>
				#include <shadowmask_pars_fragment>

				float rainHash(vec2 p) {
					return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
				}

				vec2 rainCellGrad(vec2 worldXZ, float cellScale, float speed) {
					vec2 cell = floor(worldXZ * cellScale);
					vec2 f = fract(worldXZ * cellScale);
					float n = rainHash(cell);
					vec2 drop = vec2(rainHash(cell + vec2(19.1, 7.7)), rainHash(cell + vec2(3.3, 41.2)));
					float life = fract(time * speed + n);
					vec2 d = f - drop;
					float dist = length(d);
					float front = life * 0.72;
					float amp = (1.0 - life) * smoothstep(0.0, 0.08, life);
					float ripple = sin((dist - front) * 24.0) * exp(-abs(dist - front) * 12.0) * amp;
					return (d / max(dist, 0.001)) * ripple;
				}

				void main() {

					#include <logdepthbuf_fragment>
					vec3 worldToEye = eye - worldPosition.xyz;
					float camDist = length(worldToEye);
					vec3 eyeDirection = worldToEye / max(0.0001, camDist);

					// Attenuate high-frequency normal noise beyond 110m & drop to 2-tap macro swells for distant ocean pixels
					float nearDetailFade = 1.0 - smoothstep( 85.0, 220.0, camDist );
					vec4 noise = ( camDist < 110.0 ) ? getNoise( worldPosition.xz * size ) : getNoiseFar( worldPosition.xz * size );
					vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5 * (0.45 + 0.55 * nearDetailFade), 1.0, 1.5 * (0.45 + 0.55 * nearDetailFade) ) + vec3( -vWaveSlope.x * 4.5, 0.0, -vWaveSlope.y * 4.5 ) );

					// Interactive expanding impact ripple rings (evaluated within 65m near-field)
					if ( camDist < 65.0 ) {
						float rippleNormal = 0.0;
						for (int r = 0; r < 8; r++) {
							if (uRipples[r].w > 0.01) {
								float d = distance(worldPosition.xz, uRipples[r].xy);
								float ring = sin((d - uRipples[r].z) * 9.0) * exp(-abs(d - uRipples[r].z) * 2.2) * uRipples[r].w;
								rippleNormal += ring;
							}
						}
						if (abs(rippleNormal) > 0.001) {
							surfaceNormal = normalize(surfaceNormal + vec3(rippleNormal * 0.45, 0.0, rippleNormal * 0.45));
						}
					}

					// Rain rings: two cell sizes, each with its own drop and lifetime, within 85m
					if (uRainIntensity > 0.01 && camDist < 85.0) {
						float rainFade = uRainIntensity * (1.0 - camDist / 85.0);
						vec2 rainG = rainCellGrad(worldPosition.xz, 0.62, 0.72);
						rainG += rainCellGrad(worldPosition.xz + vec2(3.7, 1.9), 1.08, 1.25) * 0.65;
						surfaceNormal = normalize(surfaceNormal + vec3(rainG.x, 0.0, rainG.y) * rainFade * 0.9);
					}

					// Underwater view looking up at the surface: Snell's Window & shimmering subsurface refraction
					if ( !gl_FrontFacing ) {
						vec3 underNormal = normalize( vec3( -surfaceNormal.x * 1.3, -1.0, -surfaceNormal.z * 1.3 ) );
						float upCos = max( 0.0, dot( -eyeDirection, underNormal ) );
						float snellWindow = smoothstep( 0.36, 0.78, upCos );
						float sunGlint = pow( max( 0.0, dot( -eyeDirection, normalize( vec3( sunDirection.x * 0.4, 1.0, sunDirection.z * 0.4 ) ) ) ), 18.0 );
						float causticShimmer = clamp( ( noise.x + noise.z ) * 0.8 + 0.5, 0.0, 1.0 );
						vec3 tirCol = vec3( 0.02, 0.24, 0.34 );
						vec3 windowSkyCol = vec3( 0.42, 0.88, 0.96 ) + sunColor * sunGlint * 1.35 + vec3( 0.18, 0.35, 0.38 ) * causticShimmer * snellWindow;
						vec3 underCol = mix( tirCol, windowSkyCol, snellWindow );
						float underAlpha = smoothstep( 0.0, 0.35, vWaterDepth ) * 0.86;
						gl_FragColor = vec4( underCol, underAlpha );
						#include <tonemapping_fragment>
						#include <fog_fragment>
						return;
					}

					vec3 diffuseLight = vec3(0.0);
					vec3 specularLight = vec3(0.0);
					sunLight( surfaceNormal, eyeDirection, 100.0, 2.0, 0.5, diffuseLight, specularLight );

					vec2 distortion = surfaceNormal.xz * ( 0.001 + 1.0 / camDist ) * distortionScale;
					float safeMirrorW = max( 0.35, mirrorCoord.w );
					vec2 projMirrorUV = clamp( mirrorCoord.xy / safeMirrorW + distortion, 0.002, 0.998 );
					vec3 reflectionSample = vec3( texture2D( mirrorSampler, projMirrorUV ) );

					float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );
					float rf0 = 0.035;
					float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );

					// Depth-based Beer-Lambert lagoon color gradient (translucent sand-tinted aqua -> turquoise -> abyssal ocean cobalt)
					float depth = max( 0.0, vWaterDepth + vWaveHeight * 0.22 );
					vec3 ultraShallowCol = vec3( 0.42, 0.76, 0.72 );
					vec3 shallowCol = vec3( 0.10, 0.70, 0.72 );
					vec3 deepCol = vec3( 0.006, 0.095, 0.185 );
					vec3 depthTint = mix( ultraShallowCol, shallowCol, smoothstep( 0.0, 0.65, depth ) );
					depthTint = mix( depthTint, waterColor, smoothstep( 0.45, 2.2, depth ) );
					depthTint = mix( depthTint, deepCol, smoothstep( 2.4, 11.5, depth ) );

					// Wave-crest subsurface sunlight scattering (translucent jade-cyan glow through swells)
					float sunBacklit = pow( max( 0.0, dot( -eyeDirection, sunDirection ) ), 3.0 );
					float sss = clamp( vWaveHeight * 0.52, 0.0, 1.0 ) * ( 0.30 + sunBacklit * 0.90 );
					vec3 sssGlow = vec3( 0.04, 0.36, 0.34 ) * sss;

					// Reduce mirror reflection weight in ultra-shallow shoreline water (< 0.5m) or when eye is at grazing wave-crest level
					float eyeHeightFade = smoothstep( 0.45, 1.25, eye.y - worldPosition.y );
					float shallowReflFade = smoothstep( 0.02, 0.65, depth ) * eyeHeightFade;
					vec3 skyFallbackCol = mix( vec3( 0.46, 0.74, 0.88 ), sunColor * 0.85, 0.25 );
					vec3 reflCol = mix( skyFallbackCol, reflectionSample, eyeHeightFade );
					vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * depthTint;
					vec3 albedo = mix( ( sunColor * diffuseLight * 0.35 + scatter + sssGlow ) * getShadowMask(), ( vec3( 0.04 ) + reflCol * 0.94 + reflCol * specularLight ), reflectance * shallowReflFade );

					// Dynamic 3D wave crest whitecaps & current foam
					float waveCrest = clamp( noise.x * noise.z * 2.2, 0.0, 1.0 );
					float swellWhitecap = smoothstep( 0.35, 1.35, vWaveHeight ) * ( 0.24 + uFoamIntensity * 0.56 );

					// Smoothly feathered shoreline surf wash & lapping edge foam (fades smoothly to 0.0 right at depth = 0.0!)
					float inShore = smoothstep( 0.03, 0.18, depth ) * ( 1.0 - smoothstep( 0.22, 1.25, depth ) );
					float surfBands = pow( max( 0.0, sin( depth * 11.5 - time * 2.8 + noise.x * 2.4 ) ), 3.0 );
					float edgeLace = smoothstep( 0.02, 0.10, depth ) * ( 1.0 - smoothstep( 0.10, 0.32, depth ) ) * ( 0.55 + 0.45 * sin( worldPosition.x * 1.8 + worldPosition.z * 1.6 + time * 2.2 ) );
					float shoreFoam = ( inShore * surfBands * ( 0.48 + uFoamIntensity * 0.32 ) + edgeLace * 0.42 );

					float foam = pow( waveCrest, 3.0 ) * ( 0.18 + uFoamIntensity * 0.35 ) * shallowReflFade + swellWhitecap + shoreFoam;
					albedo += vec3( foam );

					// Zero-seam shoreline alpha: feathers smoothly from 0.0 at depth=0.0 to translucent aqua to deep water
					float shoreFeather = smoothstep( 0.0, 0.42, depth );
					float depthAlpha = shoreFeather * mix( 0.34, 0.96, smoothstep( 0.18, 2.8, depth ) );
					float finalAlpha = clamp( max( depthAlpha, shoreFoam * 0.78 * shoreFeather ) * alpha, 0.0, 1.0 );

					vec3 outgoingLight = albedo;
					gl_FragColor = vec4( outgoingLight, finalAlpha );

					#include <tonemapping_fragment>
					#include <fog_fragment>
				}`
			};
			const material = new THREE.ShaderMaterial( {
				fragmentShader: mirrorShader.fragmentShader,
				vertexShader: mirrorShader.vertexShader,
				uniforms: THREE.UniformsUtils.clone( mirrorShader.uniforms ),
				lights: true,
				side: side,
				fog: fog,
				transparent: true,
				depthWrite: false
			} );
			material.uniforms[ 'mirrorSampler' ].value = renderTarget.texture;
			material.uniforms[ 'textureMatrix' ].value = textureMatrix;
			material.uniforms[ 'alpha' ].value = alpha;
			material.uniforms[ 'time' ].value = time;
			material.uniforms[ 'normalSampler' ].value = normalSampler;
			material.uniforms[ 'sunColor' ].value = sunColor;
			material.uniforms[ 'waterColor' ].value = waterColor;
			material.uniforms[ 'sunDirection' ].value = sunDirection;
			material.uniforms[ 'distortionScale' ].value = distortionScale;
			material.uniforms[ 'eye' ].value = eye;
			material.uniforms[ 'uWaveAmp' ].value = options.waveAmp !== undefined ? options.waveAmp : 1.0;
			scope.material = material;
			scope.renderTarget = renderTarget;

			let _currentRTSize = textureWidth;
			scope.setReflectionResolution = function ( res ) {
				const clamped = Math.max( 128, Math.min( 512, res | 0 ) );
				if ( clamped !== _currentRTSize ) {
					_currentRTSize = clamped;
					renderTarget.setSize( clamped, clamped );
					renderTarget.texture.generateMipmaps = false;
				}
			};

			let _waterMirrorFrame = 0;
			let _hasRenderedOnce = false;
			let _lastCamX = -99999, _lastCamY = -99999, _lastCamZ = -99999, _lastLookX = 0, _lastLookY = 0, _lastLookZ = -1;
			mirrorCamera.layers.set( 0 );
			window._waterReflStats = { rendered: false, res: _currentRTSize, stride: 3, skipped: false, reason: 'init' };

			scope.onBeforeRender = function ( renderer, scene, camera ) {

				mirrorWorldPosition.setFromMatrixPosition( scope.matrixWorld );
				cameraWorldPosition.setFromMatrixPosition( camera.matrixWorld );
				eye.setFromMatrixPosition( camera.matrixWorld );

				// 1. Skip planar reflection pass completely when inside caves, submerged underwater, or flagged by governor
				if ( window._playerInsideCave || ( window.caveDarknessFactor || 0 ) > 0.45 ) {
					window._waterReflStats.rendered = false;
					window._waterReflStats.skipped = true;
					window._waterReflStats.reason = 'cave';
					return;
				}
				const camHeightAboveWater = cameraWorldPosition.y - mirrorWorldPosition.y;
				if ( camHeightAboveWater < -0.08 ) {
					window._waterReflStats.rendered = false;
					window._waterReflStats.skipped = true;
					window._waterReflStats.reason = 'submerged';
					return;
				}
				if ( _hasRenderedOnce && window._skipWaterReflectionPass ) {
					window._waterReflStats.rendered = false;
					window._waterReflStats.skipped = true;
					window._waterReflStats.reason = 'budget';
					return;
				}

				_waterMirrorFrame = ( _waterMirrorFrame + 1 ) | 0;
				rotationMatrix.extractRotation( camera.matrixWorld );
				lookAtPosition.set( 0, 0, - 1 );
				lookAtPosition.applyMatrix4( rotationMatrix );

				// If camera is looking steeply upward into the sky (lookAtPosition.y > 0.58) and high above water, skip reflection
				if ( _hasRenderedOnce && lookAtPosition.y > 0.58 && camHeightAboveWater > 8.0 ) {
					window._waterReflStats.rendered = false;
					window._waterReflStats.skipped = true;
					window._waterReflStats.reason = 'sky-view';
					return;
				}

				const camMoveDelta = Math.abs( cameraWorldPosition.x - _lastCamX ) + Math.abs( cameraWorldPosition.y - _lastCamY ) + Math.abs( cameraWorldPosition.z - _lastCamZ );
				const camTurnDelta = Math.abs( lookAtPosition.x - _lastLookX ) + Math.abs( lookAtPosition.y - _lastLookY ) + Math.abs( lookAtPosition.z - _lastLookZ );
				const camMoved = camMoveDelta > 0.22;
				const camTurned = camTurnDelta > 0.016;
				const fastMotion = camMoveDelta > 0.95 || camTurnDelta > 0.085;

				// 2. Query Adaptive Frame-Budget Governor for base resolution & update stride
				const gov = window.AdaptiveGovernor;
				const baseRes = ( gov && gov.waterReflRes ) ? gov.waterReflRes : 288;
				const baseStride = ( gov && gov.waterReflStride ) ? gov.waterReflStride : 3;

				// Throttle reflection cadence based on motion, altitude & governor stride
				const activeStride = ( camMoved || camTurned )
					? ( camHeightAboveWater > 35.0 ? Math.max( baseStride, 5 ) : baseStride )
					: Math.max( baseStride * 2, 6 );

				window._waterReflStats.stride = activeStride;
				window._waterReflStats.skipped = false;

				if ( _hasRenderedOnce && ( _waterMirrorFrame % activeStride ) !== 0 ) {
					window._waterReflStats.rendered = false;
					window._waterReflStats.reason = 'throttled';
					return;
				}
				_hasRenderedOnce = true;

				// Resize RT only on frames that immediately render into it so the texture is never left blank
				let targetRes = baseRes;
				if ( fastMotion || camHeightAboveWater > 42.0 ) {
					targetRes = Math.min( baseRes, 192 );
				} else if ( camMoved || camTurned || camHeightAboveWater > 22.0 ) {
					targetRes = Math.min( baseRes, 256 );
				}
				scope.setReflectionResolution( targetRes );
				window._waterReflStats.res = _currentRTSize;

				_lastCamX = cameraWorldPosition.x; _lastCamY = cameraWorldPosition.y; _lastCamZ = cameraWorldPosition.z;
				_lastLookX = lookAtPosition.x; _lastLookY = lookAtPosition.y; _lastLookZ = lookAtPosition.z;

				rotationMatrix.extractRotation( scope.matrixWorld );
				normal.set( 0, 0, 1 );
				normal.applyMatrix4( rotationMatrix );
				view.subVectors( mirrorWorldPosition, cameraWorldPosition );

				if ( view.dot( normal ) > 0 ) return;
				view.reflect( normal ).negate();
				view.add( mirrorWorldPosition );
				rotationMatrix.extractRotation( camera.matrixWorld );
				lookAtPosition.set( 0, 0, - 1 );
				lookAtPosition.applyMatrix4( rotationMatrix );
				lookAtPosition.add( cameraWorldPosition );
				target.subVectors( mirrorWorldPosition, lookAtPosition );
				target.reflect( normal ).negate();
				target.add( mirrorWorldPosition );
				mirrorCamera.position.copy( view );
				mirrorCamera.up.set( 0, 1, 0 );
				mirrorCamera.up.applyMatrix4( rotationMatrix );
				mirrorCamera.up.reflect( normal );
				mirrorCamera.lookAt( target );
				mirrorCamera.far = Math.min( camera.far, ( gov && gov.reflFar ) ? gov.reflFar : 360.0 );

				mirrorCamera.updateMatrixWorld();
				mirrorCamera.projectionMatrix.copy( camera.projectionMatrix );

				textureMatrix.set( 0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0 );
				textureMatrix.multiply( mirrorCamera.projectionMatrix );
				textureMatrix.multiply( mirrorCamera.matrixWorldInverse );

				mirrorPlane.setFromNormalAndCoplanarPoint( normal, mirrorWorldPosition );
				mirrorPlane.applyMatrix4( mirrorCamera.matrixWorldInverse );
				clipPlane.set( mirrorPlane.normal.x, mirrorPlane.normal.y, mirrorPlane.normal.z, mirrorPlane.constant );
				const projectionMatrix = mirrorCamera.projectionMatrix;
				q.x = ( Math.sign( clipPlane.x ) + projectionMatrix.elements[ 8 ] ) / projectionMatrix.elements[ 0 ];
				q.y = ( Math.sign( clipPlane.y ) + projectionMatrix.elements[ 9 ] ) / projectionMatrix.elements[ 5 ];
				q.z = - 1.0;
				q.w = ( 1.0 + projectionMatrix.elements[ 10 ] ) / projectionMatrix.elements[ 14 ];

				clipPlane.multiplyScalar( 2.0 / clipPlane.dot( q ) );

				projectionMatrix.elements[ 2 ] = clipPlane.x;
				projectionMatrix.elements[ 6 ] = clipPlane.y;
				projectionMatrix.elements[ 10 ] = clipPlane.z + 1.0 - clipBias;
				projectionMatrix.elements[ 14 ] = clipPlane.w;
				eye.setFromMatrixPosition( camera.matrixWorld );

				const currentRenderTarget = renderer.getRenderTarget();
				const currentXrEnabled = renderer.xr.enabled;
				const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
				scope.visible = false;
				renderer.xr.enabled = false;
				renderer.shadowMap.autoUpdate = false;

				renderer.setRenderTarget( renderTarget );
				renderer.state.buffers.depth.setMask( true );

				if ( renderer.autoClear === false ) renderer.clear();
				renderer.render( scene, mirrorCamera );
				window._waterReflStats.rendered = true;
				window._waterReflStats.reason = 'active';
				scope.visible = true;
				renderer.xr.enabled = currentXrEnabled;
				renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
				renderer.setRenderTarget( currentRenderTarget );

				const viewport = camera.viewport;
				if ( viewport !== undefined ) {
					renderer.state.viewport( viewport );
				}
			};

		}

	}

	Water.prototype.isWater = true;

	THREE.Water = Water;

} )();
