( function () {

	/**
	 * Preetham Analytical Physical Sky Dome + Seamless Bilinear Cumulus Cloud Engine
	 */
	class Sky extends THREE.Mesh {

		constructor() {

			const shader = Sky.SkyShader;
			const material = new THREE.ShaderMaterial( {
				name: 'SkyShader',
				fragmentShader: shader.fragmentShader,
				vertexShader: shader.vertexShader,
				uniforms: THREE.UniformsUtils.clone( shader.uniforms ),
				side: THREE.BackSide,
				depthWrite: false,
				fog: false
			} );

			super( new THREE.SphereGeometry( 1400, 32, 20 ), material );

		}

	}

	Sky.prototype.isSky = true;
	Sky.SkyShader = {
		uniforms: {
			'turbidity': { value: 2.6 },
			'rayleigh': { value: 1.55 },
			'mieCoefficient': { value: 0.0045 },
			'mieDirectionalG': { value: 0.82 },
			'sunPosition': { value: new THREE.Vector3( 180000, 320000, -200000 ) },
			'up': { value: new THREE.Vector3( 0, 1, 0 ) },
			'nightMix': { value: 0.0 },
			'stormMix': { value: 0.0 }
		},
		vertexShader: /* glsl */`
			uniform vec3 sunPosition;
			uniform float rayleigh;
			uniform float turbidity;
			uniform float mieCoefficient;
			uniform vec3 up;

			varying vec3 vWorldPosition;
			varying vec3 vSunDirection;
			varying float vSunfade;
			varying vec3 vBetaR;
			varying vec3 vBetaM;
			varying float vSunE;

			const float e = 2.71828182845904523536028747135266249775724709369995957;

			const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
			const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

			const float cutoffAngle = 1.6110731556870734;
			const float steepness = 1.5;
			const float EE = 1000.0;

			float sunIntensity( float zenithAngleCos ) {
				zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
				return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
			}

			vec3 totalMie( float T ) {
				float c = ( 0.2 * T ) * 10E-18;
				return 0.434 * c * MieConst;
			}

			void main() {

				vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
				vWorldPosition = worldPosition.xyz;

				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				vSunDirection = normalize( sunPosition );

				vSunE = sunIntensity( dot( vSunDirection, up ) );

				vSunfade = 1.0 - clamp( 1.0 - exp( ( sunPosition.y / 450000.0 ) ), 0.0, 1.0 );

				float rayleighCoefficient = rayleigh - ( 1.0 * ( 1.0 - vSunfade ) );

				vBetaR = totalRayleigh * rayleighCoefficient;
				vBetaM = totalMie( turbidity ) * mieCoefficient;

			}
		`,
		fragmentShader: /* glsl */`
			precision highp float;

			varying vec3 vWorldPosition;
			varying vec3 vSunDirection;
			varying float vSunfade;
			varying vec3 vBetaR;
			varying vec3 vBetaM;
			varying float vSunE;

			uniform float mieDirectionalG;
			uniform vec3 up;
			uniform float nightMix;
			uniform float stormMix;

			const float pi = 3.141592653589793238462643383279502884197169;
			const float rayleighZenithLength = 8.4E3;
			const float mieZenithLength = 1.25E3;
			const float sunAngularDiameterCos = 0.999935;

			const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
			const float ONE_OVER_FOURPI = 0.07957747154594767;

			float rayleighPhase( float cosTheta ) {
				return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
			}

			float hgPhase( float cosTheta, float g ) {
				float g2 = pow( g, 2.0 );
				float inverse = 1.0 / pow( max( 0.0001, 1.0 - 2.0 * g * cosTheta + g2 ), 1.5 );
				return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
			}

			void main() {

				vec3 direction = normalize( vWorldPosition - cameraPosition );

				float zenithAngle = acos( max( 0.0, dot( up, direction ) ) );
				float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
				float sR = rayleighZenithLength * inverse;
				float sM = mieZenithLength * inverse;

				vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

				float cosTheta = dot( direction, vSunDirection );

				float rPhase = rayleighPhase( cosTheta * 0.5 + 0.5 );
				vec3 betaRTheta = vBetaR * rPhase;

				float mPhase = hgPhase( cosTheta, mieDirectionalG );
				vec3 betaMTheta = vBetaM * mPhase;

				vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / max( vec3( 1e-6 ), vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
				Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / max( vec3( 1e-6 ), vBetaR + vBetaM ) ) * Fex, vec3( 0.5 ) ), clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 1.0 ) );

				vec3 L0 = vec3( 0.1 ) * Fex;
				float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00008, cosTheta );
				L0 += ( vSunE * 14000.0 * Fex ) * sundisk * ( 1.0 - stormMix * 0.9 ) * ( 1.0 - nightMix );

				vec3 texColor = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0004, 0.0009 );
				vec3 retColor = pow( max( texColor, vec3( 0.0 ) ), vec3( 1.0 / ( 1.2 + ( 1.2 * vSunfade ) ) ) );

				// Storm slate overcast damping
				vec3 stormSky = mix( vec3( 0.24, 0.30, 0.36 ), vec3( 0.11, 0.15, 0.20 ), clamp( direction.y, 0.0, 1.0 ) );
				retColor = mix( retColor, stormSky, stormMix * 0.78 );

				// Deep moonlit midnight sky blend + soft moon disc
				vec3 nightSky = mix( vec3( 0.05, 0.10, 0.16 ), vec3( 0.015, 0.032, 0.068 ), clamp( pow( max( 0.0, direction.y ), 0.55 ), 0.0, 1.0 ) );
				if ( nightMix > 0.01 ) {
					vec3 moonDir = normalize( vec3( -vSunDirection.x, max( 0.35, abs( vSunDirection.y ) ), -vSunDirection.z ) );
					float moonDot = max( 0.0, dot( direction, moonDir ) );
					nightSky += vec3( 0.86, 0.92, 1.0 ) * ( smoothstep( 0.9994, 0.9997, moonDot ) * 1.4 + pow( moonDot, 24.0 ) * 0.18 );
				}
				retColor = mix( retColor, nightSky, nightMix );

				gl_FragColor = vec4( retColor, 1.0 );

			}
		`
	};

	/**
	 * Seamless Tileable Procedural Cumulus Cloud Texture & Vault Dome
	 * Pre-computes periodic 64-bit IEEE Perlin-value fBM on an offscreen canvas so
	 * mobile GPUs sample silky-smooth bilinear filtered clouds with ZERO shader seams.
	 */
	function createSeamlessCloudTexture( size = 512 ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext( '2d' );
		const img = ctx.createImageData( size, size );
		const data = img.data;

		function hash2( ix, iy, period ) {
			const wx = ( ( ix % period ) + period ) % period;
			const wy = ( ( iy % period ) + period ) % period;
			let n = Math.sin( wx * 127.1 + wy * 311.7 ) * 43758.5453123;
			return n - Math.floor( n );
		}

		function smoothNoise( u, v, period ) {
			const x = u * period;
			const y = v * period;
			const ix = Math.floor( x );
			const iy = Math.floor( y );
			const fx = x - ix;
			const fy = y - iy;
			const sx = fx * fx * ( 3.0 - 2.0 * fx );
			const sy = fy * fy * ( 3.0 - 2.0 * fy );
			const a = hash2( ix, iy, period );
			const b = hash2( ix + 1, iy, period );
			const c = hash2( ix, iy + 1, period );
			const d = hash2( ix + 1, iy + 1, period );
			return ( a * ( 1.0 - sx ) + b * sx ) * ( 1.0 - sy ) + ( c * ( 1.0 - sx ) + d * sx ) * sy;
		}

		function periodicFbm( u, v ) {
			let sum = 0.0;
			let amp = 0.50;
			let period = 4;
			for ( let oct = 0; oct < 5; oct++ ) {
				sum += amp * smoothNoise( u, v, period );
				period *= 2;
				amp *= 0.50;
			}
			return sum;
		}

		for ( let y = 0; y < size; y++ ) {
			const v = y / size;
			for ( let x = 0; x < size; x++ ) {
				const u = x / size;
				// Gentle domain warp for organic billowing cumulus lobes
				const wx = periodicFbm( u + 0.13, v + 0.41 ) * 0.09;
				const wy = periodicFbm( u + 0.67, v + 0.19 ) * 0.09;
				const base = periodicFbm( u + wx, v + wy );
				// Detail octave for wispy edges
				const detail = smoothNoise( u + wx * 1.4, v + wy * 1.4, 32 );
				const d = Math.max( 0.0, Math.min( 1.0, base * 0.82 + detail * 0.18 ) );

				// Offset sample toward light to encode soft top-vs-underside billowing shading in R
				const sunBias = periodicFbm( u + wx + 0.018, v + wy + 0.012 );
				const lit = Math.max( 0.0, Math.min( 1.0, 0.58 + ( d - sunBias ) * 3.2 ) );

				const idx = ( y * size + x ) * 4;
				data[ idx ] = Math.round( d * 255 );     // R: raw cloud density field
				data[ idx + 1 ] = Math.round( lit * 255 ); // G: internal sunlit highlight
				data[ idx + 2 ] = Math.round( detail * 255 );
				data[ idx + 3 ] = 255;
			}
		}

		ctx.putImageData( img, 0, 0 );
		const tex = new THREE.CanvasTexture( canvas );
		tex.wrapS = THREE.RepeatWrapping;
		tex.wrapT = THREE.RepeatWrapping;
		tex.magFilter = THREE.LinearFilter;
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		return tex;

	}

	class CloudDome extends THREE.Mesh {

		constructor() {

			const cloudTex = createSeamlessCloudTexture( 512 );
			const mat = new THREE.ShaderMaterial( {
				uniforms: {
					uCloudTex: { value: cloudTex },
					uTime: { value: 0.0 },
					uCloudCover: { value: 0.44 },
					uCloudLight: { value: new THREE.Color( 0xffffff ) },
					uCloudShadow: { value: new THREE.Color( 0xbcd4ea ) },
					uSunDir: { value: new THREE.Vector3( 0.45, 0.75, -0.5 ).normalize() },
					uOpacity: { value: 0.88 }
				},
				vertexShader: /* glsl */`
					varying vec3 vWorldPos;
					void main() {
						vec4 wp = modelMatrix * vec4( position, 1.0 );
						vWorldPos = wp.xyz;
						gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
					}
				`,
				fragmentShader: /* glsl */`
					precision highp float;

					uniform sampler2D uCloudTex;
					uniform float uTime;
					uniform float uCloudCover;
					uniform vec3 uCloudLight;
					uniform vec3 uCloudShadow;
					uniform vec3 uSunDir;
					uniform float uOpacity;
					varying vec3 vWorldPos;

					void main() {
						vec3 dir = normalize( vWorldPos - cameraPosition );
						if ( dir.y < 0.01 ) discard;

						// Overhead altitude projection with smooth horizon perspective stretch
						vec2 proj = dir.xz / ( dir.y + 0.19 );
						vec2 uv1 = proj * 0.24 + vec2( uTime * 0.0085, uTime * 0.0032 );
						vec2 uv2 = proj * 0.46 + vec2( -uTime * 0.0045 + 0.37, uTime * 0.0068 + 0.19 );

						vec4 s1 = texture2D( uCloudTex, uv1 );
						vec4 s2 = texture2D( uCloudTex, uv2 );

						float density = s1.r * 0.72 + s2.r * 0.28;
						float cutoff = mix( 0.66, 0.30, clamp( uCloudCover, 0.0, 1.0 ) );
						float alpha = smoothstep( cutoff, cutoff + 0.18, density );

						// Soft fade near the sea horizon so clouds melt into atmospheric haze
						alpha *= smoothstep( 0.01, 0.22, dir.y ) * uOpacity;
						if ( alpha < 0.004 ) discard;

						float sunForward = pow( max( 0.0, dot( dir, normalize( uSunDir ) ) ), 6.0 );
						float lit = clamp( s1.g * 0.78 + sunForward * 0.38, 0.0, 1.0 );
						vec3 col = mix( uCloudShadow, uCloudLight, lit );
						col += uCloudLight * sunForward * 0.22 * ( 1.0 - alpha * 0.4 );

						gl_FragColor = vec4( col, alpha );
					}
				`,
				side: THREE.BackSide,
				transparent: true,
				depthWrite: false,
				fog: false
			} );

			super( new THREE.SphereGeometry( 1320, 32, 20 ), mat );
			this.renderOrder = -1;

		}

	}

	THREE.Sky = Sky;
	THREE.CloudDome = CloudDome;

} )();
