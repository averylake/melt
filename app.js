const AQI_SCALE = [
  { min: 0,   max: 50,       color: '#00E400', label: 'Good', state: 1 },
  { min: 51,  max: 100,      color: '#FFFF00', label: 'Moderate', state: 2 },
  { min: 101, max: 150,      color: '#FF7E00', label: 'Unhealthy for sensitive groups', state: 3 },
  { min: 151, max: 200,      color: '#FF0000', label: 'Unhealthy', state: 4 },
  { min: 201, max: 300,      color: '#8F3F97', label: 'Very unhealthy', state: 5 },
  { min: 301, max: Infinity, color: '#7E0023', label: 'Hazardous', state: 6 }
];

const STATE_SOURCES = [
  'states/state-1.png',
  'states/state-2.png',
  'states/state-3.png',
  'states/state-4.png',
  'states/state-5.png',
  'states/state-6.png'
];

const REMOTE_API = 'https://melt.averylakeofficial.com/.netlify/functions/aqi';
const LOCAL_API = '/.netlify/functions/aqi';

const el = {
  stateFront: document.querySelector('#stateFront'),
  stateBack: document.querySelector('#stateBack'),
  aqiValue: document.querySelector('#aqiValue'),
  aqiCategory: document.querySelector('#aqiCategory'),
  locationName: document.querySelector('#locationName'),
  updatedTime: document.querySelector('#updatedTime'),
  liveText: document.querySelector('#liveText'),
  cityForm: document.querySelector('#cityForm'),
  cityInput: document.querySelector('#cityInput'),
  submitButton: document.querySelector('#submitButton'),
  geoButton: document.querySelector('#geoButton'),
  errorMessage: document.querySelector('#errorMessage'),
  saveStateButton: document.querySelector('#saveStateButton')
};

let displayedAQI = 25;
let animationFrame = null;
let refreshTimer = null;
let activeRequest = null;
let currentState = 1;
let visibleLayer = 'front';
let activeLiveReading = null;

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function categoryFor(aqi) {
  const value = Math.max(0, Number(aqi) || 0);
  return AQI_SCALE.find(item => value >= item.min && value <= item.max) || AQI_SCALE[AQI_SCALE.length - 1];
}

function stageForAQI(aqi) {
  return categoryFor(aqi).state;
}

function setStage(stateIndex) {
  if (stateIndex === currentState) return;
  const nextSrc = STATE_SOURCES[stateIndex - 1];
  const incoming = visibleLayer === 'front' ? el.stateBack : el.stateFront;
  const outgoing = visibleLayer === 'front' ? el.stateFront : el.stateBack;
  incoming.src = nextSrc;
  incoming.classList.add('is-visible');
  outgoing.classList.remove('is-visible');
  visibleLayer = visibleLayer === 'front' ? 'back' : 'front';
  currentState = stateIndex;
}

function renderArtwork(aqi) {
  const cat = categoryFor(aqi);
  document.documentElement.style.setProperty('--current-aqi', cat.color);
  setStage(stageForAQI(aqi));
  return cat;
}

function setReading(aqi, meta = {}) {
  const rounded = Math.max(0, Math.round(aqi));
  const cat = categoryFor(rounded);
  el.aqiValue.textContent = rounded;
  el.aqiCategory.textContent = cat.label;
  el.liveText.textContent = `Live US AQI · ${cat.label}`;
  if (meta.location) el.locationName.textContent = meta.location;
  if (meta.timestamp) {
    const date = new Date(meta.timestamp);
    const formatted = Number.isNaN(date.getTime())
      ? meta.timestamp
      : new Intl.DateTimeFormat(undefined, {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
        }).format(date);
    el.updatedTime.textContent = `IQAir reading updated ${formatted}`;
  }

  if (meta.isLive) {
    activeLiveReading = {
      aqi: rounded,
      category: cat.label,
      color: cat.color,
      state: cat.state,
      location: meta.location || 'Selected location',
      timestamp: meta.timestamp || new Date().toISOString(),
      mainPollutant: meta.mainPollutant || null
    };
    el.saveStateButton.hidden = false;
  }
}

function animateToAQI(target, meta = {}) {
  if (animationFrame) cancelAnimationFrame(animationFrame);
  const start = performance.now();
  const from = displayedAQI;
  const to = clamp(Number(target), 0, 500);
  const duration = 1100;

  function frame(now) {
    const p = clamp((now - start) / duration, 0, 1);
    const eased = easeInOut(p);
    displayedAQI = lerp(from, to, eased);
    renderArtwork(displayedAQI);
    el.aqiValue.textContent = Math.round(displayedAQI);
    el.aqiCategory.textContent = categoryFor(displayedAQI).label;
    if (p < 1) animationFrame = requestAnimationFrame(frame);
    else {
      displayedAQI = to;
      renderArtwork(to);
      setReading(to, meta);
      animationFrame = null;
    }
  }
  animationFrame = requestAnimationFrame(frame);
}

function setLoading(isLoading) {
  el.submitButton.disabled = isLoading;
  el.geoButton.disabled = isLoading;
  el.submitButton.textContent = isLoading ? 'READING…' : 'ACTIVATE';
}

function showError(message) {
  el.errorMessage.textContent = message || '';
}

function apiEndpoint() {
  const host = window.location.hostname;
  if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.netlify.app') || host === 'melt.averylakeofficial.com') {
    return LOCAL_API;
  }
  return REMOTE_API;
}

async function fetchAQI(params) {
  const query = new URLSearchParams(params);
  const response = await fetch(`${apiEndpoint()}?${query.toString()}`, {
    headers: { 'Accept': 'application/json' }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not retrieve air quality data.');
  return data;
}

function locationLabel(data) {
  return [data.city, data.state, data.country].filter(Boolean).join(', ');
}

function scheduleRefresh(request) {
  activeRequest = request;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!activeRequest) return;
    if (activeRequest.type === 'city') activateCity(activeRequest.city, { silent: true });
    else activateCoordinates(activeRequest.lat, activeRequest.lon, { silent: true });
  }, 60 * 60 * 1000);
}

async function activateCity(city, options = {}) {
  if (!options.silent) showError('');
  if (!options.silent) setLoading(true);
  if (!options.silent) { activeLiveReading = null; el.saveStateButton.hidden = true; }
  try {
    const data = await fetchAQI({ city });
    const label = locationLabel(data);
    animateToAQI(data.aqi, { location: label, timestamp: data.timestamp, mainPollutant: data.mainPollutant, isLive: true });
    el.cityInput.value = city;
    localStorage.setItem('melting-point-city', city);
    scheduleRefresh({ type: 'city', city });
    const url = new URL(window.location.href);
    url.searchParams.set('city', city);
    url.searchParams.delete('aqi');
    history.replaceState({}, '', url);
  } catch (error) {
    if (!options.silent) showError(error.message);
  } finally {
    if (!options.silent) setLoading(false);
  }
}

async function activateCoordinates(lat, lon, options = {}) {
  if (!options.silent) showError('');
  if (!options.silent) setLoading(true);
  if (!options.silent) { activeLiveReading = null; el.saveStateButton.hidden = true; }
  try {
    const data = await fetchAQI({ lat, lon });
    const label = locationLabel(data);
    animateToAQI(data.aqi, { location: label, timestamp: data.timestamp, mainPollutant: data.mainPollutant, isLive: true });
    scheduleRefresh({ type: 'coordinates', lat, lon });
  } catch (error) {
    if (!options.silent) showError(error.message);
  } finally {
    if (!options.silent) setLoading(false);
  }
}

el.cityForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const city = el.cityInput.value.trim();
  if (!city) {
    showError('Enter a town or city first.');
    return;
  }
  activateCity(city);
});

el.geoButton.addEventListener('click', () => {
  showError('');
  if (!navigator.geolocation) {
    showError('Location access is not available in this browser.');
    return;
  }
  setLoading(true);
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      setLoading(false);
      activateCoordinates(coords.latitude, coords.longitude);
    },
    () => {
      setLoading(false);
      showError('Location permission was not granted. You can enter a city instead.');
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
  );
});


function formatSnapshotDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp || '');
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  }).format(date);
}

function safeFilenamePart(value) {
  return String(value || 'location')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'location';
}

async function loadSnapshotImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not prepare the artwork image.'));
    image.src = src;
  });
}

async function saveThisState() {
  if (!activeLiveReading) return;

  const reading = { ...activeLiveReading };
  el.saveStateButton.disabled = true;
  const originalLabel = el.saveStateButton.textContent;
  el.saveStateButton.textContent = 'PREPARING…';

  try {
    const stateImage = await loadSnapshotImage(STATE_SOURCES[reading.state - 1]);
    const size = 1600;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Gallery-like field matching the artwork website.
    ctx.fillStyle = '#F4EFE8';
    ctx.fillRect(0, 0, size, size);

    // The live state occupies the upper field, intentionally shifted upward.
    const artSize = 1320;
    const artX = (size - artSize) / 2;
    const artY = -125;
    ctx.drawImage(stateImage, artX, artY, artSize, artSize);

    // Archival metadata area.
    const left = 120;
    const right = size - 120;
    const lineY = 1225;
    ctx.strokeStyle = 'rgba(23,23,23,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, lineY);
    ctx.lineTo(right, lineY);
    ctx.stroke();

    ctx.fillStyle = '#171717';
    ctx.textBaseline = 'top';
    ctx.font = '600 38px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('MELTING POINT', left, 1265);

    ctx.fillStyle = '#706D68';
    ctx.font = '500 20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText('A LIVE AQI STATE', left, 1325);

    ctx.fillStyle = '#171717';
    ctx.font = '500 28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const location = reading.location;
    ctx.fillText(location, left, 1374);

    ctx.fillStyle = reading.color;
    ctx.beginPath();
    ctx.arc(left + 9, 1436, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#171717';
    ctx.font = '600 24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(`US AQI ${reading.aqi} · ${reading.category.toUpperCase()}`, left + 28, 1421);

    ctx.fillStyle = '#706D68';
    ctx.font = '400 20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(formatSnapshotDate(reading.timestamp), left, 1475);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#171717';
    ctx.font = '500 20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('Artwork by Avery Lake', right, 1270);
    ctx.fillStyle = '#706D68';
    ctx.fillText('Live AQI via IQAir AirVisual', right, 1310);
    ctx.fillText('U.S. EPA AQI color standard', right, 1346);
    ctx.font = '500 19px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText('melt.averylakeofficial.com', right, 1475);
    ctx.textAlign = 'left';

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create the PNG.');

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date(reading.timestamp);
    const datePart = Number.isNaN(date.getTime()) ? 'live' : date.toISOString().slice(0, 10);
    link.href = url;
    link.download = `melting-point_${safeFilenamePart(reading.location)}_${datePart}_aqi-${reading.aqi}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showError(error.message || 'Could not save this state.');
  } finally {
    el.saveStateButton.disabled = false;
    el.saveStateButton.textContent = originalLabel;
  }
}

el.saveStateButton.addEventListener('click', saveThisState);

function initIdleState() {
  // The artwork exists before a location is chosen, but no AQI claim is made.
  renderArtwork(25);
  displayedAQI = 25;
  document.documentElement.style.setProperty('--current-aqi', '#8C8882');
  el.aqiValue.textContent = '—';
  el.aqiCategory.textContent = 'Awaiting location';
  el.locationName.textContent = 'No location selected';
  el.updatedTime.textContent = 'Enter a city or use your location to connect the artwork to live air quality.';
  el.liveText.textContent = 'Choose a location to activate live AQI';
  activeLiveReading = null;
  el.saveStateButton.hidden = true;
}

initIdleState();

const params = new URLSearchParams(window.location.search);
const demoAQI = params.get('aqi');
const cityFromURL = params.get('city');
const savedCity = localStorage.getItem('melting-point-city');

if (demoAQI !== null && !Number.isNaN(Number(demoAQI))) {
  const value = clamp(Number(demoAQI), 0, 500);
  animateToAQI(value, { location: 'Manual AQI test', timestamp: new Date().toISOString() });
  el.liveText.textContent = 'Manual AQI test · not live data';
} else if (cityFromURL) {
  el.cityInput.value = cityFromURL;
  activateCity(cityFromURL);
} else if (savedCity) {
  el.cityInput.value = savedCity;
}
