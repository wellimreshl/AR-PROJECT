import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MODEL_URL = '/assets/porsche_911_ar.glb';
const DRACO_DECODER_PATH = '/draco/gltf/';

// Target longest-axis length for the Porsche in AR world-space (metres).
// 1.0 m gives a clearly visible, desk/floor-scale AR impression.
// Adjust this constant to change the initial AR size without touching any
// other part of the code — the scale is derived dynamically from the GLB bbox.
const TARGET_AR_LENGTH = 1.0;

// Resolved after the GLB loads; used in AR and restored on session end.
let arModelScale = 1.0;

let scene, camera, renderer;
let object, reticle;
let isStarted = false;
let modelReady = false;

let hitTestSource = null;
let hitTestSourceRequested = false;
let controller;

// The world reference space used for rendering & hit-test pose queries.
// Resolved at session-start via getSupportedReferenceSpace().
let worldReferenceSpace = null;

let modelLoadPromise = null;

function init() {
  const container = document.getElementById('app');

  // 1. Scene Setup
  scene = new THREE.Scene();
  // We start with a dark background for the 2D web view
  scene.background = new THREE.Color(0x0f172a);

  // 2. Camera Setup (far plane sized for the scaled car in AR)
  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.01,
    100
  );
  camera.position.set(4, 2, 7);
  camera.lookAt(0, 0.8, 0);

  // 3. Renderer Setup
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Tone mapping for physically correct PBR lighting
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // Enable WebXR
  renderer.xr.enabled = true;

  container.appendChild(renderer.domElement);

  // Set up Environment Map for PBR Reflections (Critical for metallic objects like cars)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  pmrem.dispose();

  // 4. Lighting Setup — used in both 2D preview and AR mode.
  // HemisphereLight gives warm sky + cool ground fill; important for PBR
  // materials to avoid the "all black" look when there is no env-map.
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444466, 0.9);
  scene.add(hemiLight);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.4);
  directionalLight.position.set(5, 10, 7);
  scene.add(directionalLight);

  // Secondary fill light from opposite side to reduce harsh shadows in AR.
  const fillLight = new THREE.DirectionalLight(0xc8d8ff, 0.6);
  fillLight.position.set(-8, 4, -5);
  scene.add(fillLight);

  // 5. Placement root (Porsche is loaded asynchronously into this group)
  object = new THREE.Group();
  object.visible = false;
  scene.add(object);

  // 6. AR Reticle Setup (Used for hit-testing placement)
  // Larger ring so it's easy to see at arm's length
  const reticleGeometry = new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2);
  const reticleMaterial = new THREE.MeshBasicMaterial({
    color: 0x00ddff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  reticle = new THREE.Mesh(reticleGeometry, reticleMaterial);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // 7. AR Controller Setup (For handling taps/clicks)
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  // 8. Handle Window Resize
  window.addEventListener('resize', onWindowResize);

  // 9. UI Interaction Setup & WebXR Support Check
  setupUI();

  // 10. Start Animation Loop
  renderer.setAnimationLoop(animate);
}

let arPath = 'NONE';
const USDZ_URL = '/assets/model.usdz';

function detectPlatformLabel() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android';
  if (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ) {
    return 'iOS/iPadOS';
  }
  return 'desktop/other';
}

function setUiStatus(buttonText, instructionText, { disabled = true } = {}) {
  const startBtn = document.getElementById('start-btn');
  const instruction = document.querySelector('.instruction');
  startBtn.textContent = buttonText;
  startBtn.disabled = disabled;
  instruction.textContent = instructionText;
}

/**
 * Shows a dismissible on-screen diagnostic panel when WebXR fails.
 * Displays the raw error name/message plus environment details so the
 * actual rejection reason is always visible rather than a generic alert.
 * NOTE: Remove or gate behind a debug flag before final public release.
 */
function showARDiagnostic(title, details) {
  // Remove any previous panel
  document.getElementById('ar-diagnostic')?.remove();

  const panel = document.createElement('div');
  panel.id = 'ar-diagnostic';
  panel.style.cssText = [
    'position:fixed', 'inset:0',
    'background:rgba(8,10,20,0.96)', 'color:#f1f5f9',
    'font-family:ui-monospace,monospace', 'font-size:13px',
    'padding:28px 24px', 'overflow-y:auto',
    'z-index:9999', 'box-sizing:border-box',
  ].join(';');

  panel.innerHTML = `
    <div style="max-width:640px;margin:0 auto">
      <div style="color:#f87171;font-size:17px;font-weight:700;margin-bottom:18px">&#9888; ${title}</div>
      <pre style="white-space:pre-wrap;word-break:break-word;line-height:1.7;margin:0 0 24px;background:rgba(255,255,255,.06);padding:16px;border-radius:8px">${details}</pre>
      <button id="ar-diag-close" style="padding:10px 28px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;font-family:inherit">Dismiss &amp; Try Again</button>
    </div>
  `;

  document.body.appendChild(panel);

  document.getElementById('ar-diag-close')?.addEventListener('click', () => {
    panel.remove();
    // Restore the landing overlay so the user can retry
    document.getElementById('ui-overlay')?.classList.remove('hidden');
    setUiStatus(
      'START AR',
      'Tap START AR, then point at a flat surface and tap to place the Porsche.',
      { disabled: false }
    );
  });
}

function loadPorscheModel() {
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    return new Promise((resolve, reject) => {
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
      dracoLoader.setDecoderConfig({ type: 'wasm' });

      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);

      const absoluteUrl = new URL(MODEL_URL, window.location.href).href;

      loader.load(
        absoluteUrl,
        (gltf) => {
          try {
            const model = gltf.scene;
            if (!model) {
              throw new Error('gltf.scene is missing after parse');
            }

            // --- Material Diagnostics ---
            let matCount = 0;
            model.traverse((child) => {
              if (child.isMesh) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach(mat => {
                  matCount++;
                  console.info(`[Material] name: ${mat.name}, type: ${mat.type}, color: ${mat.color?.getHexString()}, roughness: ${mat.roughness}, metalness: ${mat.metalness}`);
                });
              }
            });
            console.info(`[AR Model] Total materials found: ${matCount}`);
            // ----------------------------

            // ── Step 1: Measure the raw GLB bounding box (scale = 1.0) ──────────
            // We must do this BEFORE applying any scale, otherwise the bbox
            // reflects the scaled dimensions and the scale calculation is circular.
            model.scale.set(1, 1, 1);
            const rawBox = new THREE.Box3().setFromObject(model);
            const rawSize = new THREE.Vector3();
            rawBox.getSize(rawSize);

            // The longest axis determines the scale so the car fits TARGET_AR_LENGTH
            // regardless of whether the GLB was exported in metres, centimetres, etc.
            const longestRawAxis = Math.max(rawSize.x, rawSize.y, rawSize.z);
            if (longestRawAxis <= 0) throw new Error('GLB bounding box is degenerate (size = 0).');

            arModelScale = TARGET_AR_LENGTH / longestRawAxis;

            console.info(
              '[AR Model] Loaded:', absoluteUrl,
              `\n  raw GLB bbox : ${rawSize.x.toFixed(3)} × ${rawSize.y.toFixed(3)} × ${rawSize.z.toFixed(3)} units`,
              `\n  longest axis : ${longestRawAxis.toFixed(3)} units`,
              `\n  TARGET_AR_LENGTH : ${TARGET_AR_LENGTH} m`,
              `\n  computed scale   : ${arModelScale.toFixed(6)}`,
            );

            // ── Step 2: Apply computed scale ─────────────────────────────────────
            model.scale.setScalar(arModelScale);

            // ── Step 3: Measure post-scale bbox for ground-alignment ─────────────
            // (rawBox × scale gives the same result but measuring again is safer
            // in case the model has non-uniform internal transforms.)
            const scaledBox = new THREE.Box3().setFromObject(model);
            const scaledSize = new THREE.Vector3();
            const scaledCenter = new THREE.Vector3();
            scaledBox.getSize(scaledSize);
            scaledBox.getCenter(scaledCenter);

            console.info(
              '[AR Model] Post-scale bbox:',
              `${scaledSize.x.toFixed(3)} × ${scaledSize.y.toFixed(3)} × ${scaledSize.z.toFixed(3)} m`,
              `| min.y=${scaledBox.min.y.toFixed(3)} max.y=${scaledBox.max.y.toFixed(3)}`,
            );

            // ── Step 4: Ground-align — shift model so bbox bottom sits at y=0 ───
            // model.position.y = -scaledBox.min.y lifts the model so its lowest
            // point coincides with the parent group's XZ plane (the hit surface).
            model.position.x = -scaledCenter.x;
            model.position.y = -scaledBox.min.y;   // ← wheels touch the surface
            model.position.z = -scaledCenter.z;

            while (object.children.length > 0) {
              object.remove(object.children[0]);
            }
            object.add(model);

            // ── Step 5: Frame 2D preview camera around the scaled car ────────────
            const radius = Math.max(scaledSize.x, scaledSize.y, scaledSize.z) * 0.75;
            camera.position.set(radius * 0.9, scaledSize.y * 0.55, radius * 1.35);
            camera.near = 0.01;
            camera.far = Math.max(100, radius * 8);
            camera.lookAt(0, scaledSize.y * 0.35, 0);
            camera.updateProjectionMatrix();

            object.position.set(0, 0, 0);
            object.visible = true;

            modelReady = true;

            dracoLoader.dispose();
            resolve(model);
          } catch (err) {
            modelReady = false;
            dracoLoader.dispose();
            reject(err);
          }
        },
        undefined, // progress callback not needed in production
        (err) => {
          modelReady = false;
          dracoLoader.dispose();
          reject(err || new Error(`Failed to load ${absoluteUrl}`));
        }
      );
    });
  })();

  return modelLoadPromise;
}

async function setupUI() {
  const startBtn = document.getElementById('start-btn');
  startBtn.disabled = true;

  // 0. Secure context guard — WebXR requires HTTPS. Catches misconfigured dev/staging environments.
  if (!window.isSecureContext) {
    setUiStatus(
      'AR UNAVAILABLE',
      'WebXR requires a secure connection (HTTPS). Please access this page over HTTPS.',
      { disabled: true }
    );
    startDesktopModelPreview();
    return;
  }

  // 1. Check WebXR (Android)
  let webxrSupported = false;
  if ('xr' in navigator) {
    try {
      webxrSupported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (e) {
      console.warn('[WebXR] isSessionSupported threw:', e);
    }
  }

  if (webxrSupported) {
    arPath = 'WEBXR';
    startBtn.addEventListener('click', handleARButtonClick);

    // Enable START AR immediately — model loads in background while user reads the prompt.
    // The button click handler waits for modelReady before launching the session.
    setUiStatus(
      'START AR',
      'Tap START AR, then point at a flat surface and tap to place the Porsche.',
      { disabled: false }
    );

    // Kick off background load (do not await — UI is already unlocked above)
    loadPorscheModel().catch((err) => {
      console.error('Porsche model failed to load:', err);
      setUiStatus(
        'MODEL FAILED',
        'Failed to load the 3D model. Please refresh and try again.',
        { disabled: true }
      );
    });
    return;
  }

  // 2. Check iOS Quick Look fallback
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    arPath = 'QUICKLOOK';
    startBtn.addEventListener('click', handleARButtonClick);
    setUiStatus('START AR', 'Scan your surroundings and interact with digital objects in the real world.', {
      disabled: false,
    });
    return;
  }

  // 3. Unsupported platform — show desktop preview
  arPath = 'NONE';
  setUiStatus(
    'AR UNAVAILABLE',
    'Your browser or device does not support WebXR Immersive AR or Apple AR Quick Look.',
    { disabled: true }
  );

  startDesktopModelPreview();
}

/**
 * Desktop-only 3D preview so the model can be inspected without AR hardware.
 * Does not affect AR routing or enable START AR.
 */
async function startDesktopModelPreview() {
  applyDesktopPreviewLighting();

  // Visible ground reference
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(10, 64),
    new THREE.MeshStandardMaterial({
      color: 0xc8c8c8,
      roughness: 0.85,
      metalness: 0.0,
      envMapIntensity: 0.35,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(12, 12, 0x888888, 0xb0b0b0);
  grid.position.y = 0.002;
  scene.add(grid);

  try {
    await loadPorscheModel();
    if (!modelReady) {
      throw new Error('Model finished loading but was not marked ready.');
    }

    // Hide the glass card so the 3D Porsche is visible for desktop review
    document.getElementById('ui-overlay')?.classList.add('hidden');
    object.visible = true;

    console.info('[Desktop Preview] Porsche ready — overlay hidden for model inspection.');
  } catch (err) {
    console.error('[Desktop Preview] Failed to load Porsche:', err);
    setUiStatus(
      'AR UNAVAILABLE',
      'Failed to load the 3D model preview.',
      { disabled: true }
    );
  }
}

/**
 * Neutral studio lighting + RoomEnvironment IBL for PBR inspection on desktop.
 * Production AR lights set in init() are left as-is.
 */
function applyDesktopPreviewLighting() {
  scene.background = new THREE.Color(0xb8b8b8);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 0.85);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(5, 8, 4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xf0f4ff, 0.7);
  fill.position.set(-6, 4, -2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  rim.position.set(-2, 5, -8);
  scene.add(rim);

  const front = new THREE.DirectionalLight(0xffffff, 0.45);
  front.position.set(0, 3, 10);
  scene.add(front);
}

function handleARButtonClick() {
  if (arPath === 'WEBXR') {
    if (!modelReady) {
      // Model is still downloading — show a brief loading state and retry once ready.
      setUiStatus('LOADING MODEL…', 'Almost ready — the 3D model is still downloading. Please wait a moment.', {
        disabled: true,
      });
      loadPorscheModel()
        .then(() => {
          setUiStatus(
            'START AR',
            'Tap START AR, then point at a flat surface and tap to place the Porsche.',
            { disabled: false }
          );
        })
        .catch(() => {
          setUiStatus('MODEL FAILED', 'Failed to load the 3D model. Please refresh.', { disabled: true });
        });
      return;
    }
    startWebXRSession();
  } else if (arPath === 'QUICKLOOK') {
    startQuickLookSession();
  }
}

function startQuickLookSession() {
  const a = document.createElement('a');
  a.setAttribute('rel', 'ar');
  a.setAttribute('href', USDZ_URL);

  // Apple recommends appending an image child to intercept properly in some iOS versions
  const img = document.createElement('img');
  a.appendChild(img);

  a.click();
}

/**
 * Tries to acquire a world reference space in order of AR suitability:
 *   1. 'local'       — best for AR: device-relative, stable, widely supported
 *   2. 'local-floor' — good for room-scale AR with floor tracking
 *   3. 'viewer'      — last resort; poses are eye-relative but hit-test still works
 *
 * 'viewer' is intentionally NOT used as the world reference space if avoidable,
 * because hit-test pose results queried against a viewer-origin space cause the
 * reticle to drift with head movement rather than sticking to the real surface.
 */
async function getSupportedReferenceSpace(session) {
  const spacesToTry = ['local', 'local-floor', 'viewer'];
  for (const type of spacesToTry) {
    try {
      const space = await session.requestReferenceSpace(type);
      console.info(`[WebXR] World reference space resolved: '${type}'`);
      return { space, type };
    } catch (e) {
      console.warn(`[WebXR] Reference space '${type}' not supported:`, e.message);
    }
  }
  // All attempts failed — throw with a descriptive message
  throw new DOMException(
    `No supported reference space found. Tried: ${spacesToTry.join(', ')}.`,
    'NotSupportedError'
  );
}

async function startWebXRSession() {
  const overlay = document.getElementById('ui-overlay');

  try {
    // 'hit-test' is the only required feature — it enables surface detection.
    // 'local' and 'local-floor' are listed as optional so the session is still
    // granted even if the device only supports a subset of reference spaces.
    // We resolve the best available world reference space at runtime below.
    // This call MUST stay inside the user-click handler (transient activation).
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local', 'local-floor'],
    });

    session.addEventListener('end', onSessionEnded);

    // Hand the session to Three.js — sets up the XR render loop internally
    await renderer.xr.setSession(session);

    // Resolve the best available world reference space for rendering & hit-test pose queries.
    // This is separate from the 'viewer' space used as the hit-test source origin.
    const { space, type: spaceType } = await getSupportedReferenceSpace(session);
    worldReferenceSpace = space;

    // Override Three.js's internal reference space so poses are expressed
    // in our chosen world space (important when 'local-floor' or 'viewer' wins).
    renderer.xr.setReferenceSpace(worldReferenceSpace);

    console.info(`[WebXR] Session started. World reference space: '${spaceType}'`);

    // UI changes for AR mode
    isStarted = true;
    overlay.classList.add('hidden');

    // Transparent background exposes the camera feed
    scene.background = null;

    // Porsche hidden until the user taps a surface to place it
    object.visible = false;

  } catch (err) {
    // --- Detailed diagnostic — surfaces the real rejection reason ---

    // Probe additional environment state for the diagnostic
    let arSupported = 'unknown';
    try {
      arSupported = String(
        await navigator.xr?.isSessionSupported?.('immersive-ar') ?? 'navigator.xr missing'
      );
    } catch (probeErr) {
      arSupported = `isSessionSupported threw: ${probeErr.message}`;
    }

    const diag = [
      `error name    : ${err.name    ?? '(none)'}`,
      `error message : ${err.message ?? '(none)'}`,
      ``,
      `secure context: ${window.isSecureContext}`,
      `protocol      : ${location.protocol}`,
      `hostname      : ${location.hostname}`,
      `navigator.xr  : ${'xr' in navigator}`,
      `ar supported  : ${arSupported}`,
      ``,
      `user agent    : ${navigator.userAgent}`,
    ].join('\n');

    // Map known WebXR error types to actionable descriptions
    const causes = {
      SecurityError:
        'Permissions-Policy is blocking xr-spatial-tracking, or the page is not served over HTTPS. ' +
        'Check that the server sends: Permissions-Policy: xr-spatial-tracking=*',
      NotAllowedError:
        'Camera or AR permission was denied by the user or OS. ' +
        'Check site permissions in Chrome Settings and ensure camera access is allowed.',
      NotSupportedError:
        'The WebXR session started but none of the required reference space types ' +
        '(local, local-floor, viewer) are supported by this device. ' +
        'This is unusual — please ensure ARCore is installed and fully updated, ' +
        'then reload the page. If the problem persists, your device may not support ' +
        'WebXR hit-testing even though it reports immersive-ar as available.',
      InvalidStateError:
        'An AR session is already active, or the XR subsystem is in an invalid state. Try reloading the page.',
      AbortError:
        'The AR session request was aborted. The browser may have interrupted it due to focus loss or another active session.',
    };

    const cause = causes[err.name] ?? `Unrecognised error (${err.name ?? 'no name'}). See console for stack trace.`;
    const title = `WebXR failed: ${err.name ?? 'Error'}`;

    console.error('[WebXR] AR session failed\n', diag, '\nCause hint:', cause, '\nFull error:', err);
    showARDiagnostic(title, `${cause}\n\n${diag}`);

    // Restore landing overlay so the user isn't stuck on a blank screen
    overlay.classList.remove('hidden');
  }
}

function onSessionEnded() {
  isStarted = false;
  hitTestSourceRequested = false;
  hitTestSource = null;
  worldReferenceSpace = null;

  // Restore 2D preview state
  const overlay = document.getElementById('ui-overlay');
  overlay.classList.remove('hidden');
  scene.background = new THREE.Color(0x0f172a);

  // Show the Porsche again in the centered preview
  object.position.set(0, 0, 0);
  object.rotation.set(0, 0, 0);
  object.visible = modelReady;
  reticle.visible = false;
}

function onSelect() {
  if (reticle.visible && modelReady) {
    // Place the Porsche on the detected surface (group origin = ground contact)
    object.position.setFromMatrixPosition(reticle.matrix);
    object.visible = true;
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate(timestamp, frame) {
  // If we have an active XR frame (in AR mode)
  if (frame) {
    const session = renderer.xr.getSession();

    // 1. Request Hit Test Source on the first frame
    //    The hit-test SOURCE uses 'viewer' (camera/eye origin) — this is the
    //    standard approach: rays are cast from the viewer's perspective.
    //    The hit-test RESULT pose is then queried against worldReferenceSpace
    //    so the reticle is expressed in the stable world coordinate frame.
    if (hitTestSourceRequested === false) {
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
          hitTestSource = source;
          // Show the reticle immediately once hit-test is ready,
          // even before any surface is found, so user sees feedback right away.
          reticle.visible = true;
        }).catch((e) => {
          console.warn('[WebXR] requestHitTestSource failed:', e);
        });
      }).catch((e) => {
        console.warn('[WebXR] requestReferenceSpace(viewer) for hit-test failed:', e);
      });

      session.addEventListener('end', () => {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });

      hitTestSourceRequested = true;
    }

    // 2. Perform Hit Test — snap reticle to real-world surface.
    //    Pose is expressed in worldReferenceSpace (the stable world frame),
    //    NOT the viewer space, so the reticle stays fixed on the surface
    //    rather than following the camera.
    if (hitTestSource && worldReferenceSpace) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);

      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(worldReferenceSpace);
        if (pose) {
          // Snap to the detected surface
          reticle.matrix.fromArray(pose.transform.matrix);
          reticle.visible = true;
        }
      }
      // When no surface hit, leave reticle where it last was (rather than hiding it)
      // so the user always sees the ring and knows where to tap.
    }
  }

  renderer.render(scene, camera);
}

// Initialize the app
init();
