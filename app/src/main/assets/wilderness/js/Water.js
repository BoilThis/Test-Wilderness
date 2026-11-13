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
				format: THREE.RGBFormat
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

				void main() {

					#include <logdepthbuf_fragment>
					vec4 noise = getNoise( worldPosition.xz * size );
					vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) + vec3( -vWaveSlope.x * 4.5, 0.0, -vWaveSlope.y * 4.5 ) );

					// Interactive expanding impact ripple rings
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

					// Dynamic rain droplet ripples
					if (uRainIntensity > 0.01) {
						float rainWave = sin(worldPosition.x * 22.0 + time * 12.0) * cos(worldPosition.z * 22.0 + time * 14.0) * 0.22 * uRainIntensity;
						surfaceNormal = normalize(surfaceNormal + vec3(rainWave, 0.0, rainWave));
					}

					vec3 worldToEye = eye - worldPosition.xyz;
					vec3 eyeDirection = normalize( worldToEye );

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

					float distance = length(worldToEye);

					vec2 distortion = surfaceNormal.xz * ( 0.001 + 1.0 / distance ) * distortionScale;
					vec3 reflectionSample = vec3( texture2D( mirrorSampler, mirrorCoord.xy / mirrorCoord.w + distortion ) );

					float theta = max( dot( eyeDirection, surfaceNormal ), 0.0 );
					float rf0 = 0.035;
					float reflectance = rf0 + ( 1.0 - rf0 ) * pow( ( 1.0 - theta ), 5.0 );

					// Depth-based Beer-Lambert lagoon color gradient (translucent sand-tinted aqua -> turquoise -> deep ocean cobalt)
					float depth = max( 0.0, vWaterDepth + vWaveHeight * 0.22 );
					vec3 ultraShallowCol = vec3( 0.42, 0.76, 0.72 );
					vec3 shallowCol = vec3( 0.10, 0.70, 0.72 );
					vec3 deepCol = vec3( 0.008, 0.15, 0.25 );
					vec3 depthTint = mix( ultraShallowCol, shallowCol, smoothstep( 0.0, 0.65, depth ) );
					depthTint = mix( depthTint, waterColor, smoothstep( 0.45, 2.1, depth ) );
					depthTint = mix( depthTint, deepCol, smoothstep( 2.4, 8.8, depth ) );

					// Wave-crest subsurface sunlight scattering (translucent jade-cyan glow through swells)
					float sunBacklit = pow( max( 0.0, dot( -eyeDirection, sunDirection ) ), 3.0 );
					float sss = clamp( vWaveHeight * 0.52, 0.0, 1.0 ) * ( 0.30 + sunBacklit * 0.90 );
					vec3 sssGlow = vec3( 0.04, 0.36, 0.34 ) * sss;

					// Reduce mirror reflection weight in ultra-shallow shoreline water (< 0.5m) so submerged sand/pebbles blend seamlessly
					float shallowReflFade = smoothstep( 0.02, 0.65, depth );
					vec3 scatter = max( 0.0, dot( surfaceNormal, eyeDirection ) ) * depthTint;
					vec3 albedo = mix( ( sunColor * diffuseLight * 0.35 + scatter + sssGlow ) * getShadowMask(), ( vec3( 0.04 ) + reflectionSample * 0.94 + reflectionSample * specularLight ), reflectance * shallowReflFade );

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

			scope.onBeforeRender = function ( renderer, scene, camera ) {

				mirrorWorldPosition.setFromMatrixPosition( scope.matrixWorld );
				cameraWorldPosition.setFromMatrixPosition( camera.matrixWorld );
				eye.setFromMatrixPosition( camera.matrixWorld );
				rotationMatrix.extractRotation( scope.matrixWorld );
				normal.set( 0, 0, 1 );
				normal.applyMatrix4( rotationMatrix );
				view.subVectors( mirrorWorldPosition, cameraWorldPosition ); // Avoid planar mirror pass when camera is underwater

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
				mirrorCamera.far = camera.far; // Used in WebGLBackground

				mirrorCamera.updateMatrixWorld();
				mirrorCamera.projectionMatrix.copy( camera.projectionMatrix ); // Update the texture matrix

				textureMatrix.set( 0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0 );
				textureMatrix.multiply( mirrorCamera.projectionMatrix );
				textureMatrix.multiply( mirrorCamera.matrixWorldInverse ); // Now update projection matrix with new clip plane, implementing code from: http://www.terathon.com/code/oblique.html
				// Paper explaining this technique: http://www.terathon.com/lengyel/Lengyel-Oblique.pdf

				mirrorPlane.setFromNormalAndCoplanarPoint( normal, mirrorWorldPosition );
				mirrorPlane.applyMatrix4( mirrorCamera.matrixWorldInverse );
				clipPlane.set( mirrorPlane.normal.x, mirrorPlane.normal.y, mirrorPlane.normal.z, mirrorPlane.constant );
				const projectionMatrix = mirrorCamera.projectionMatrix;
				q.x = ( Math.sign( clipPlane.x ) + projectionMatrix.elements[ 8 ] ) / projectionMatrix.elements[ 0 ];
				q.y = ( Math.sign( clipPlane.y ) + projectionMatrix.elements[ 9 ] ) / projectionMatrix.elements[ 5 ];
				q.z = - 1.0;
				q.w = ( 1.0 + projectionMatrix.elements[ 10 ] ) / projectionMatrix.elements[ 14 ]; // Calculate the scaled plane vector

				clipPlane.multiplyScalar( 2.0 / clipPlane.dot( q ) ); // Replacing the third row of the projection matrix

				projectionMatrix.elements[ 2 ] = clipPlane.x;
				projectionMatrix.elements[ 6 ] = clipPlane.y;
				projectionMatrix.elements[ 10 ] = clipPlane.z + 1.0 - clipBias;
				projectionMatrix.elements[ 14 ] = clipPlane.w;
				eye.setFromMatrixPosition( camera.matrixWorld ); // Render

				const currentRenderTarget = renderer.getRenderTarget();
				const currentXrEnabled = renderer.xr.enabled;
				const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
				scope.visible = false;
				renderer.xr.enabled = false; // Avoid camera modification and recursion

				renderer.shadowMap.autoUpdate = false; // Avoid re-computing shadows

				renderer.setRenderTarget( renderTarget );
				renderer.state.buffers.depth.setMask( true ); // make sure the depth buffer is writable so it can be properly cleared, see #18897

				if ( renderer.autoClear === false ) renderer.clear();
				renderer.render( scene, mirrorCamera );
				scope.visible = true;
				renderer.xr.enabled = currentXrEnabled;
				renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
				renderer.setRenderTarget( currentRenderTarget ); // Restore viewport

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
