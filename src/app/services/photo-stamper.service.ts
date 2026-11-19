import { Injectable } from '@angular/core';
import { Geolocation, Position } from '@capacitor/geolocation';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { SettingsService } from './settings.service';

const GPS_CACHE_TTL_MS = 30_000;
const GPS_CACHE_KEY = 'smartcam_gps_cache';
const GEO_CACHE_KEY = 'smartcam_geo_cache';
const GEO_CACHE_TTL_MS = 5 * 60_000;
const TILE_CACHE_MAX = 30;
const TILE_GRID_DEGREES = 0.005;
const TILE_CACHE_DIR = 'smartcam_tiles';
const GALLERY_CACHE_KEY = 'smartcam_gallery_cache';

interface GpsCache {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

interface GeoCache {
  lat: number;
  lng: number;
  address: string[];
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class PhotoStamperService {
  private gpsCache: GpsCache | null = null;
  private geoCache: GeoCache | null = null;
  private tileMemCache = new Map<string, string>();
  private galleryCache: string[] = [];
  private galleryLoaded = false;
  private watchId: string | null = null;

  constructor(private settingsService: SettingsService) {
    this.restoreGpsCache();
    this.restoreGeoCache();
    this.restoreGalleryCache();
  }

  startGpsWatch(): void {
    if (this.watchId) return;
    try {
      Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 3000 },
        (position) => {
          if (position?.coords) {
            const entry: GpsCache = {
              lat: position.coords.latitude,
              lng: position.coords.longitude,
              accuracy: position.coords.accuracy,
              timestamp: Date.now()
            };
            this.gpsCache = entry;
            Preferences.set({ key: GPS_CACHE_KEY, value: JSON.stringify(entry) }).catch(() => { });
          }
        }
      ).then(id => {
        this.watchId = id;
      }).catch(() => { });
    } catch { }
  }

  stopGpsWatch(): void {
    if (this.watchId) {
      Geolocation.clearWatch({ id: this.watchId }).catch(() => { });
      this.watchId = null;
    }
  }

  async processAndSavePhoto(base64Image: string): Promise<string> {
    const s = this.settingsService.settings;

    const positionPromise = this.getPosition(s.highAccuracyGps, s.gpsTimeout);

    const position = await positionPromise;
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;

    const now = new Date();
    const formattedDate = s.showTimestamp
      ? `${now.toLocaleString('en-US', { month: 'short' })} ${now.getDate()}, ${now.getFullYear()} ${now.toLocaleTimeString('en-US', { hour12: true })}`
      : '';

    const offset = s.mapZoomOffset * 0.001;

    const timeoutPromise = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

    const [addressLines, mapDataUrl] = await Promise.all([
      s.showAddress
        ? timeoutPromise(this.getAddress(lat, lng), 3000, this.fallbackAddress(lat, lng))
        : Promise.resolve([]),
      s.showMapOverlay
        ? timeoutPromise(this.fetchSatelliteMapTile(lat, lng, offset), 4000, null)
        : Promise.resolve(null)
    ]);

    const watermarkedDataUrl = await this.burnReferenceLayout(
      base64Image,
      lat,
      lng,
      formattedDate,
      addressLines,
      mapDataUrl
    );

    if (s.saveToGallery) {
      await this.saveToDeviceGallery(watermarkedDataUrl);
      this.galleryLoaded = false;
    }

    return watermarkedDataUrl;
  }

  async getSavedPhotos(onCacheHit?: (photos: string[]) => void): Promise<string[]> {
    if (this.galleryLoaded && this.galleryCache.length > 0 && onCacheHit) {
      onCacheHit([...this.galleryCache]);
    }
    const fresh = await this.readPhotosFromDisk();
    this.galleryCache = fresh;
    this.galleryLoaded = true;
    this.persistGalleryCache(fresh);
    return fresh;
  }

  async preloadGallery(): Promise<void> {
    if (this.galleryLoaded) return;
    try {
      this.galleryCache = await this.readPhotosFromDisk();
      this.galleryLoaded = true;
      this.persistGalleryCache(this.galleryCache);
    } catch { }
  }

  get cachedGallery(): string[] {
    return [...this.galleryCache];
  }

  private async getPosition(highAccuracy: boolean, timeoutSec: number): Promise<Position> {
    if (this.gpsCache && Date.now() - this.gpsCache.timestamp < GPS_CACHE_TTL_MS) {
      return this.buildPositionFromCache(this.gpsCache);
    }

    try {
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: highAccuracy,
        timeout: Math.min(timeoutSec * 1000, 3000),
        maximumAge: 5000
      });

      const entry: GpsCache = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: Date.now()
      };
      this.gpsCache = entry;
      Preferences.set({ key: GPS_CACHE_KEY, value: JSON.stringify(entry) }).catch(() => { });

      return position;
    } catch {
      if (this.gpsCache) {
        return this.buildPositionFromCache(this.gpsCache);
      }
      return this.buildPositionFromCache({ lat: 0, lng: 0, accuracy: 0, timestamp: Date.now() });
    }
  }

  private buildPositionFromCache(c: GpsCache): Position {
    return {
      coords: {
        latitude: c.lat,
        longitude: c.lng,
        accuracy: c.accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        magneticHeading: undefined,
        trueHeading: undefined,
        headingAccuracy: undefined,
        course: undefined
      },
      timestamp: c.timestamp
    };
  }

  private async restoreGpsCache(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: GPS_CACHE_KEY });
      if (value) {
        const parsed: GpsCache = JSON.parse(value);
        if (Date.now() - parsed.timestamp < GPS_CACHE_TTL_MS) {
          this.gpsCache = parsed;
        }
      }
    } catch { }
  }

  private async getAddress(lat: number, lng: number): Promise<string[]> {
    if (lat === 0 && lng === 0) return ['Location unavailable'];

    const grid = TILE_GRID_DEGREES;
    const roundedLat = Math.round(lat / grid) * grid;
    const roundedLng = Math.round(lng / grid) * grid;

    if (
      this.geoCache &&
      Math.abs(this.geoCache.lat - roundedLat) < grid &&
      Math.abs(this.geoCache.lng - roundedLng) < grid &&
      Date.now() - this.geoCache.timestamp < GEO_CACHE_TTL_MS
    ) {
      return this.geoCache.address;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14&addressdetails=1`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept-Language': 'en', 'User-Agent': 'SmartCam/1.0' }
      });
      clearTimeout(timeoutId);

      if (!response.ok) return this.fallbackAddress(lat, lng);

      const data = await response.json();
      const a = data.address || {};

      const lines: string[] = [];
      const road = a.road || a.pedestrian || a.footway || a.path || '';
      const suburb = a.suburb || a.neighbourhood || a.quarter || '';
      const city = a.city || a.town || a.village || a.municipality || '';
      const province = a.state || a.province || a.region || '';
      const country = a.country || '';

      if (road) lines.push(road);
      if (suburb && suburb !== city) lines.push(suburb);
      if (city) lines.push(city);
      if (province) lines.push(province);
      if (country) lines.push(country);

      const result = lines.length > 0 ? lines : this.fallbackAddress(lat, lng);

      const entry: GeoCache = {
        lat: roundedLat,
        lng: roundedLng,
        address: result,
        timestamp: Date.now()
      };
      this.geoCache = entry;
      Preferences.set({ key: GEO_CACHE_KEY, value: JSON.stringify(entry) }).catch(() => { });

      return result;
    } catch {
      return this.fallbackAddress(lat, lng);
    }
  }

  fallbackAddress(lat: number, lng: number): string[] {
    return [`${lat.toFixed(4)}°, ${lng.toFixed(4)}°`];
  }

  private async restoreGeoCache(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: GEO_CACHE_KEY });
      if (value) {
        const parsed: GeoCache = JSON.parse(value);
        if (Date.now() - parsed.timestamp < GEO_CACHE_TTL_MS) {
          this.geoCache = parsed;
        }
      }
    } catch { }
  }

  private tileKey(lat: number, lng: number, offset: number): string {
    const gridLat = Math.round(lat / TILE_GRID_DEGREES) * TILE_GRID_DEGREES;
    const gridLng = Math.round(lng / TILE_GRID_DEGREES) * TILE_GRID_DEGREES;
    const zoom = Math.round(offset * 10000);
    return `${gridLat.toFixed(4)}_${gridLng.toFixed(4)}_${zoom}`;
  }

  private async fetchSatelliteMapTile(
    lat: number,
    lng: number,
    offset: number
  ): Promise<string | null> {
    if (lat === 0 && lng === 0) return null;

    const key = this.tileKey(lat, lng, offset);

    if (this.tileMemCache.has(key)) {
      return this.tileMemCache.get(key)!;
    }

    const diskTile = await this.readTileFromDisk(key);
    if (diskTile && diskTile.startsWith('data:image')) {
      this.tileMemCache.set(key, diskTile);
      return diskTile;
    }

    const urls = [
      `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${lng - offset},${lat - offset},${lng + offset},${lat + offset}&bboxSR=4326&imageSR=4326&size=500,400&f=image`,
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${lng - offset},${lat - offset},${lng + offset},${lat + offset}&bboxSR=4326&imageSR=4326&size=500,400&f=image`
    ];

    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'Accept': 'image/png,image/jpeg,*/*' }
        });
        clearTimeout(timeoutId);

        if (!response.ok) continue;

        const blob = await response.blob();
        if (blob.size < 500) continue;

        const dataUrl = await this.blobToDataUrl(blob);

        if (this.tileMemCache.size >= TILE_CACHE_MAX) {
          const oldest = this.tileMemCache.keys().next().value;
          if (oldest) this.tileMemCache.delete(oldest);
        }
        this.tileMemCache.set(key, dataUrl);
        this.writeTileToDisk(key, dataUrl).catch(() => { });

        return dataUrl;
      } catch { }
    }

    return null;
  }

  private async readTileFromDisk(key: string): Promise<string | null> {
    try {
      const result = await Filesystem.readFile({
        path: `${TILE_CACHE_DIR}/${key}.txt`,
        directory: Directory.Cache
      });
      return result.data as string;
    } catch {
      return null;
    }
  }

  private async writeTileToDisk(key: string, dataUrl: string): Promise<void> {
    try {
      await Filesystem.mkdir({ path: TILE_CACHE_DIR, directory: Directory.Cache, recursive: true }).catch(() => { });
      await Filesystem.writeFile({
        path: `${TILE_CACHE_DIR}/${key}.txt`,
        data: dataUrl,
        directory: Directory.Cache
      });
    } catch { }
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('FileReader error'));
      reader.readAsDataURL(blob);
    });
  }

  private async readPhotosFromDisk(): Promise<string[]> {
    try {
      const result = await Filesystem.readdir({ path: '', directory: Directory.Data });
      const sortedFiles = result.files
        .filter(f => f.name.endsWith('.jpg'))
        .sort()
        .reverse();

      const photoUris: string[] = [];
      for (const file of sortedFiles) {
        const uriResult = await Filesystem.getUri({ path: file.name, directory: Directory.Data });
        const win = window as any;
        const formatted = win.Ionic?.WebView
          ? win.Ionic.WebView.convertFileSrc(uriResult.uri)
          : uriResult.uri;
        photoUris.push(formatted);
      }
      return photoUris;
    } catch (e) {
      console.error('Error reading gallery paths:', e);
      return [];
    }
  }

  private async persistGalleryCache(photos: string[]): Promise<void> {
    try {
      await Preferences.set({ key: GALLERY_CACHE_KEY, value: JSON.stringify(photos.slice(0, 50)) });
    } catch { }
  }

  private async restoreGalleryCache(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: GALLERY_CACHE_KEY });
      if (value) {
        const parsed: string[] = JSON.parse(value);
        if (parsed.length > 0 && !this.galleryLoaded) {
          this.galleryCache = parsed;
        }
      }
    } catch { }
  }

  private burnReferenceLayout(
    dataUrl: string,
    lat: number,
    lng: number,
    timestamp: string,
    addressLines: string[],
    mapDataUrl: string | null
  ): Promise<string> {
    const s = this.settingsService.settings;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('burn-timeout')), 8000);

      const img = new Image();
      img.onload = async () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            clearTimeout(timeoutId);
            return reject('Could not get canvas context');
          }

          ctx.drawImage(img, 0, 0);

          const padding = Math.floor(canvas.width * 0.03);
          const mapWidth = Math.floor(canvas.width * 0.32);
          const mapHeight = Math.floor(mapWidth * 0.78);
          const mapX = padding;
          const mapY = canvas.height - mapHeight - padding;

          if (s.showMapOverlay) {
            await this.drawMapOnCanvas(ctx, mapDataUrl, mapX, mapY, mapWidth, mapHeight);
          }

          this.renderMetadataText(ctx, lat, lng, timestamp, addressLines, canvas.width, canvas.height, padding);
          clearTimeout(timeoutId);
          resolve(canvas.toDataURL('image/jpeg', s.photoQuality / 100));
        } catch (err) {
          clearTimeout(timeoutId);
          reject(err);
        }
      };
      img.onerror = (err) => {
        clearTimeout(timeoutId);
        reject(err);
      };
      img.src = dataUrl;
    });
  }

  private drawMapOnCanvas(
    ctx: CanvasRenderingContext2D,
    mapDataUrl: string | null,
    mapX: number,
    mapY: number,
    mapWidth: number,
    mapHeight: number
  ): Promise<void> {
    return new Promise((resolve) => {
      const radius = Math.max(8, Math.floor(mapWidth * 0.04));
      const borderWidth = Math.max(3, Math.floor(mapWidth * 0.015));

      const renderPinAndDecorations = () => {
        const centerX = mapX + mapWidth / 2;
        const centerY = mapY + mapHeight / 2;

        const pulseRadius = Math.max(12, Math.floor(mapWidth * 0.07));
        ctx.beginPath();
        ctx.arc(centerX, centerY, pulseRadius, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
        ctx.fill();

        const pinSize = Math.max(14, Math.floor(mapWidth * 0.065));
        const headY = centerY - pinSize * 1.35;
        const headRadius = pinSize * 0.65;

        ctx.beginPath();
        ctx.ellipse(centerX, centerY + 2, pinSize * 0.35, pinSize * 0.15, 0, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(centerX, headY, headRadius, Math.PI * 0.8, Math.PI * 0.2, true);
        ctx.lineTo(centerX, centerY);
        ctx.closePath();
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.lineWidth = Math.max(2, Math.floor(pinSize * 0.12));
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(centerX, headY, headRadius * 0.42, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        const badgeHeight = Math.max(14, Math.floor(mapHeight * 0.13));
        const badgeWidth = Math.max(48, Math.floor(mapWidth * 0.32));
        const badgeX = mapX + Math.floor(mapWidth * 0.035);
        const badgeY = mapY + Math.floor(mapHeight * 0.045);
        const badgeRadius = badgeHeight / 2;

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, badgeRadius);
        } else {
          ctx.rect(badgeX, badgeY, badgeWidth, badgeHeight);
        }
        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        ctx.fill();

        ctx.font = `bold ${Math.max(9, Math.floor(badgeHeight * 0.65))}px sans-serif`;
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('SATELLITE', badgeX + badgeWidth / 2, badgeY + badgeHeight / 2);

        ctx.restore();

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(mapX, mapY, mapWidth, mapHeight, radius);
        } else {
          ctx.rect(mapX, mapY, mapWidth, mapHeight);
        }
        ctx.lineWidth = borderWidth;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        resolve();
      };

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = Math.max(6, Math.floor(mapWidth * 0.02));
      ctx.shadowOffsetY = Math.max(2, Math.floor(mapWidth * 0.01));
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(mapX, mapY, mapWidth, mapHeight, radius);
      } else {
        ctx.rect(mapX, mapY, mapWidth, mapHeight);
      }
      ctx.fillStyle = '#0f172a';
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(mapX, mapY, mapWidth, mapHeight, radius);
      } else {
        ctx.rect(mapX, mapY, mapWidth, mapHeight);
      }
      ctx.clip();

      if (mapDataUrl) {
        const mapImg = new Image();
        const mapTimeout = setTimeout(() => {
          this.drawFallbackMapTerrain(ctx, mapX, mapY, mapWidth, mapHeight);
          renderPinAndDecorations();
        }, 3000);
        mapImg.onload = () => {
          clearTimeout(mapTimeout);
          ctx.drawImage(mapImg, mapX, mapY, mapWidth, mapHeight);
          renderPinAndDecorations();
        };
        mapImg.onerror = () => {
          clearTimeout(mapTimeout);
          this.drawFallbackMapTerrain(ctx, mapX, mapY, mapWidth, mapHeight);
          renderPinAndDecorations();
        };
        mapImg.src = mapDataUrl;
      } else {
        this.drawFallbackMapTerrain(ctx, mapX, mapY, mapWidth, mapHeight);
        renderPinAndDecorations();
      }
    });
  }

  private drawFallbackMapTerrain(
    ctx: CanvasRenderingContext2D,
    mapX: number,
    mapY: number,
    mapWidth: number,
    mapHeight: number
  ): void {
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(mapX, mapY, mapWidth, mapHeight);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mapX, mapY + mapHeight / 2);
    ctx.lineTo(mapX + mapWidth, mapY + mapHeight / 2);
    ctx.moveTo(mapX + mapWidth / 2, mapY);
    ctx.lineTo(mapX + mapWidth / 2, mapY + mapHeight);
    ctx.stroke();
  }

  private renderMetadataText(
    ctx: CanvasRenderingContext2D,
    lat: number,
    lng: number,
    timestamp: string,
    addressLines: string[],
    canvasWidth: number,
    canvasHeight: number,
    padding: number
  ) {
    const s = this.settingsService.settings;
    const fontSizeMultiplier =
      s.watermarkFontSize === 'small' ? 0.018 : s.watermarkFontSize === 'large' ? 0.03 : 0.024;

    const lines: string[] = [];
    if (timestamp) lines.push(timestamp);
    if (s.showCoordinates) {
      lines.push(
        s.coordinateFormat === 'dms'
          ? `${this.convertToDMS(lat, true)} ${this.convertToDMS(lng, false)}`
          : `${lat.toFixed(6)}°, ${lng.toFixed(6)}°`
      );
    }
    if (s.showAddress) {
      lines.push(...addressLines);
    }

    const fontSize = Math.max(14, Math.floor(canvasWidth * fontSizeMultiplier));
    const lineHeight = fontSize * 1.4;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';

    let startY = canvasHeight - padding;
    const rightX = canvasWidth - padding;

    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#FFFFFF';

    for (let i = lines.length - 1; i >= 0; i--) {
      ctx.fillText(lines[i], rightX, startY);
      startY -= lineHeight;
    }
    ctx.shadowBlur = 0;
  }

  private convertToDMS(decimalCoord: number, isLat: boolean): string {
    const absolute = Math.abs(decimalCoord);
    const degrees = Math.floor(absolute);
    const minutesNT = (absolute - degrees) * 60;
    const minutes = Math.floor(minutesNT);
    const seconds = ((minutesNT - minutes) * 60).toFixed(3);
    const direction = isLat ? (decimalCoord >= 0 ? 'N' : 'S') : decimalCoord >= 0 ? 'E' : 'W';
    return `${degrees}°${minutes}'${seconds}"${direction}`;
  }

  private async saveToDeviceGallery(base64Data: string) {
    try {
      const fileName = `SmartGeotag_${Date.now()}.jpg`;
      const base64Content = base64Data.split(',')[1] || base64Data;
      await Filesystem.writeFile({
        path: fileName,
        data: base64Content,
        directory: Directory.Data
      });
    } catch (e) {
      console.error('Error saving file locally:', e);
    }
  }
}
