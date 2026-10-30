const httpClient = require('@actions/http-client');

// GitHub-hosted images, read from the table at the top of the runner-images
// README so new and deprecated images show up without a Routact release.
const IMAGES_README = 'https://raw.githubusercontent.com/actions/runner-images/main/README.md';
const HOSTED_LABEL = /^(ubuntu|macos|windows|xcode)-/;

// Returns [{name, arch, labels: [...], status: 'ga' | 'beta' | 'preview' | 'deprecated'}]
function parseImages(markdown) {
  const images = [];
  let inTable = false;
  for (const line of markdown.split('\n')) {
    if (/^\|\s*Image\s*\|.*YAML Label/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) {
      if (images.length > 0) break;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0].replace(/\s/g, ''))) continue;
    const [imageCell, arch, labelCell] = cells;
    const labels = [...labelCell.matchAll(/`([^`]+)`/g)].map((match) => match[1].toLowerCase());
    if (labels.length === 0) continue;
    const badge = /badge\/(deprecated|beta|preview)-/i.exec(imageCell);
    images.push({
      name: imageCell.split('<br>')[0].replace(/\[!\[.*$/, '').trim(),
      arch: arch.toLowerCase(),
      labels,
      status: badge ? badge[1].toLowerCase() : 'ga',
    });
  }
  return images;
}

async function fetchImages({ http } = {}) {
  const client = http || new httpClient.HttpClient('routact', [], { allowRetries: true, maxRetries: 3, socketTimeout: 15000 });
  const response = await client.get(IMAGES_README);
  const body = await response.readBody();
  if (response.message.statusCode !== 200) {
    throw new Error(`Could not read the runner-images list (status ${response.message.statusCode})`);
  }
  const images = parseImages(body);
  if (images.length === 0) throw new Error('Could not find the image table in the runner-images README');
  return images;
}

function isHostedLabel(label) {
  return HOSTED_LABEL.test(label.toLowerCase());
}

function findImage(images, label) {
  return images.find((image) => image.labels.includes(label.toLowerCase()));
}

function versionOf(label) {
  const match = /-(\d+(?:\.\d+)?)(?=-|$)/.exec(label);
  return match ? match[1] : undefined;
}

function compareVersions(a, b) {
  const [aMajor, aMinor = 0] = a.split('.').map(Number);
  const [bMajor, bMinor = 0] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

// The newest generally available label of the same kind, e.g. ubuntu-24.04-arm
// -> ubuntu-26.04-arm or macos-15-intel -> macos-26-intel. Labels without a
// version (ubuntu-latest) never get a suggestion.
function newerLabel(images, label) {
  const version = versionOf(label);
  if (!version) return undefined;
  const available = new Set(images.filter((image) => image.status === 'ga').flatMap((image) => image.labels));
  const candidates = images
    .flatMap((image) => image.labels)
    .map(versionOf)
    .filter((candidate) => candidate && compareVersions(candidate, version) > 0)
    .sort(compareVersions)
    .reverse();
  for (const candidate of candidates) {
    const replacement = label.toLowerCase().replace(`-${version}`, `-${candidate}`);
    if (available.has(replacement)) return replacement;
  }
  return undefined;
}

module.exports = { IMAGES_README, parseImages, fetchImages, isHostedLabel, findImage, newerLabel };
