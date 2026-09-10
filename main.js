import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const MODEL_URL = '/assets/porsche_911_ar.glb';
const DRACO_DECODER_PATH = '/draco/gltf/';
// Initial AR placement scale: ~5% of real-world size (~22 cm long) — good table-top AR size.
const MODEL_SCALE = 0.05;

let scene, camera, renderer;
let object, reticle;
let isStarted = false;
let modelReady = false;

let hitTestSource = null;
let hitTestSourceRequested = false;
let controller;

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

  // Enable WebXR
  renderer.xr.enabled = true;

  container.appendChild(renderer.domElement);

  // 4. Lighting Setup
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
  directionalLight.position.set(10, 20, 10);
  scene.add(directionalLight);

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

            model.scale.setScalar(MODEL_SCALE);

            // Ground-align: bottom of bbox on y=0, centered on XZ
            const box = new THREE.Box3().setFromObject(model);
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            box.getSize(size);
            box.getCenter(center);

            console.info(
              '[AR Model] Loaded',
              absoluteUrl,
              `size≈ ${size.x.toFixed(2)}m × ${size.y.toFixed(2)}m × ${size.z.toFixed(2)}m`,
              `scale=${MODEL_SCALE}`
            );

            model.position.x = -center.x;
            model.position.y = -box.min.y;
            model.position.z = -center.z;

            while (object.children.length > 0) {
              object.remove(object.children[0]);
            }
            object.add(model);

            // Frame 2D preview camera around the scaled car
            const radius = Math.max(size.x, size.y, size.z) * 0.75;
            camera.position.set(radius * 0.9, size.y * 0.55, radius * 1.35);
            camera.near = 0.01;
            camera.far = Math.max(100, radius * 8);
            camera.lookAt(0, size.y * 0.35, 0);
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

  // 1. Check WebXR (Android)
  let webxrSupported = false;
  if ('xr' in navigator) {
    try {
      webxrSupported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (e) {}
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

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  pmrem.dispose();

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

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
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

async function startWebXRSession() {
  const overlay = document.getElementById('ui-overlay');

  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
    });

    session.addEventListener('end', onSessionEnded);

    // Pass session to Three.js
    await renderer.xr.setSession(session);

    // UI changes for AR
    isStarted = true;
    overlay.classList.add('hidden');

    // Make background transparent for camera feed
    scene.background = null;

    // Hide the Porsche until the user taps to place it
    object.visible = false;
  } catch (err) {
    console.error('Failed to start AR session:', err);
    alert('Failed to start AR session. Please ensure camera permissions are granted.');
  }
}

function onSessionEnded() {
  isStarted = false;
  hitTestSourceRequested = false;
  hitTestSource = null;

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
    const referenceSpace = renderer.xr.getReferenceSpace();

    // 1. Request Hit Test Source on the first frame
    if (hitTestSourceRequested === false) {
      session.requestReferenceSpace('viewer').then((viewerSpace) => {
        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
          hitTestSource = source;
          // Show the reticle immediately once hit-test is ready,
          // even before any surface is found, so user sees feedback right away.
          reticle.visible = true;
        });
      });

      session.addEventListener('end', () => {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });

      hitTestSourceRequested = true;
    }

    // 2. Perform Hit Test — snap to real surface when found, else keep last position
    if (hitTestSource) {
      const hitTestResults = frame.getHitTestResults(hitTestSource);

      if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);
        // Snap to the detected surface
        reticle.matrix.fromArray(pose.transform.matrix);
        reticle.visible = true;
      }
      // When no surface hit, leave reticle where it last was (rather than hiding it)
      // so the user always sees the ring and knows where to tap.
    }
  }

  renderer.render(scene, camera);
}

// Initialize the app
init();
