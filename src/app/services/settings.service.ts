import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

export interface AppSettings {

  defaultCamera: 'rear' | 'front';
  photoQuality: number;
  saveToGallery: boolean;
  highAccuracyGps: boolean;
  gpsTimeout: number;
  showCoordinates: boolean;
  coordinateFormat: 'dms' | 'decimal';
  showAddress: boolean;
  showTimestamp: boolean;

  showMapOverlay: boolean;
  mapZoomOffset: number;

  showGridOnStart: boolean;
  keepScreenOn: boolean;
  uiTheme: 'dark' | 'light';

  watermarkFontSize: 'small' | 'medium' | 'large';
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultCamera: 'rear',
  photoQuality: 85,
  saveToGallery: true,

  highAccuracyGps: true,
  gpsTimeout: 7,
  showCoordinates: true,
  coordinateFormat: 'dms',
  showAddress: true,
  showTimestamp: true,

  showMapOverlay: true,
  mapZoomOffset: 4,

  showGridOnStart: false,
  keepScreenOn: false,
  uiTheme: 'dark',

  watermarkFontSize: 'medium',
};

const STORAGE_KEY = 'smartcam_settings';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private _settings: AppSettings = { ...DEFAULT_SETTINGS };

  get settings(): AppSettings {
    return this._settings;
  }

  async load(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: STORAGE_KEY });
      if (value) {
        this._settings = { ...DEFAULT_SETTINGS, ...JSON.parse(value) };
      }
    } catch {
      this._settings = { ...DEFAULT_SETTINGS };
    }
  }

  async save(): Promise<void> {
    await Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(this._settings) });
  }

  async update(partial: Partial<AppSettings>): Promise<void> {
    this._settings = { ...this._settings, ...partial };
    await this.save();
  }

  async reset(): Promise<void> {
    this._settings = { ...DEFAULT_SETTINGS };
    await this.save();
  }
}

