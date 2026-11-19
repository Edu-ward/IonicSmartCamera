import { Component, OnInit, OnDestroy, NgZone, HostListener, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonIcon, IonButtons } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  flashOutline, flash, gridOutline, imagesOutline, settingsOutline,
  camera, syncOutline, arrowBackOutline, chevronBackOutline, chevronForwardOutline, closeOutline,
  trashOutline, phonePortraitOutline, phoneLandscapeOutline,
  checkmarkCircle, alertCircle
} from 'ionicons/icons';
import { CameraPreview, CameraPreviewOptions } from '@capacitor-community/camera-preview';
import { Camera } from '@capacitor/camera';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { ModalController } from '@ionic/angular';
import { PhotoStamperService } from '../services/photo-stamper.service';
import { SettingsComponent } from '../settings/settings.component';
import { SettingsService } from '../services/settings.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss'],
  standalone: true,
  imports: [
    CommonModule, IonHeader, IonToolbar, IonTitle,
    IonContent, IonButton, IonIcon, IonButtons
  ]
})
export class HomePage implements OnInit, OnDestroy {
  cameraInitialized = false;
  viewingGallery = false;
  allGalleryPhotos: string[] = [];
  selectedGalleryPhoto: string | null = null;
  selectedGalleryPhotoIndex: number | null = null;
  touchStartX = 0;
  touchStartY = 0;
  touchDeltaX = 0;
  isSwiping = false;
  isFlashOn = false;
  isGridVisible = false;
  isFrontCamera = false;
  isLandscape = false;
  isCapturing = false;
  shutterFlashing = false;
  toastMessage: string | null = null;
  toastType: 'success' | 'error' | null = null;

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private isStartingCamera = false;
  private restartInProgress = false;
  private lastCaptureTime = 0;
  private cameraRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private orientationHandler = () => this.onOrientationChange();
  private backButtonSub: PluginListenerHandle | null = null;

  constructor(
    private photoStamper: PhotoStamperService,
    private modalController: ModalController,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
    public settingsService: SettingsService
  ) {
    addIcons({
      flashOutline, flash, gridOutline, imagesOutline,
      settingsOutline, camera, syncOutline, arrowBackOutline,
      chevronBackOutline, chevronForwardOutline, closeOutline, trashOutline,
      phonePortraitOutline, phoneLandscapeOutline,
      checkmarkCircle, alertCircle
    });
  }

  async ngOnInit() {
    try {
      await this.settingsService.load();
    } catch (e) {
      console.warn('Settings load error', e);
    }
    this.isGridVisible = this.settingsService.settings.showGridOnStart;
    this.isFrontCamera = this.settingsService.settings.defaultCamera === 'front';
    this.isLandscape = window.innerWidth > window.innerHeight;
    window.addEventListener('orientationchange', this.orientationHandler);
    this.photoStamper.preloadGallery();
    this.zone.run(() => {
      this.allGalleryPhotos = this.photoStamper.cachedGallery;
    });
    this.setupBackButtonListener();
    this.initCameraPreview(true);
  }

  ngOnDestroy() {
    window.removeEventListener('orientationchange', this.orientationHandler);
    if (this.cameraRestartTimer) clearTimeout(this.cameraRestartTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.backButtonSub) {
      this.backButtonSub.remove();
      this.backButtonSub = null;
    }
    this.stopCameraPreview();
  }

  showToast(message: string, type: 'success' | 'error', durationMs = 2600) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.zone.run(() => {
      this.toastMessage = message;
      this.toastType = type;
      this.cdr.detectChanges();
    });
    if (durationMs > 0) {
      this.toastTimer = setTimeout(() => {
        this.zone.run(() => {
          this.toastMessage = null;
          this.toastType = null;
          this.cdr.detectChanges();
        });
      }, durationMs);
    }
  }

  hideToast() {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.zone.run(() => {
      this.toastMessage = null;
      this.toastType = null;
      this.cdr.detectChanges();
    });
  }

  async ionViewWillEnter() {
    if (!this.viewingGallery && !this.cameraInitialized) {
      this.initCameraPreview(true);
    }
  }

  async ionViewDidEnter() {
    if (!this.viewingGallery && !this.cameraInitialized) {
      this.initCameraPreview();
    }
  }

  async ionViewWillLeave() {
    await this.stopCameraPreview();
  }

  @HostListener('window:resize')
  onResize() {
    const landscape = window.innerWidth > window.innerHeight;
    if (landscape !== this.isLandscape) {
      this.zone.run(() => { this.isLandscape = landscape; });
    }
    if (this.cameraRestartTimer) clearTimeout(this.cameraRestartTimer);
    if (this.cameraInitialized && !this.viewingGallery) {
      this.cameraRestartTimer = setTimeout(() => this.restartCamera(), 350);
    }
  }

  private onOrientationChange() {
    const angle = (screen.orientation?.angle ?? window.orientation ?? 0);
    const landscape = angle === 90 || angle === -90 || angle === 270;
    this.zone.run(() => { this.isLandscape = landscape; });
    if (this.cameraInitialized && !this.viewingGallery) {
      if (this.cameraRestartTimer) clearTimeout(this.cameraRestartTimer);
      this.cameraRestartTimer = setTimeout(() => this.restartCamera(), 350);
    }
  }

  private async restartCamera() {
    if (this.restartInProgress) return;
    this.restartInProgress = true;
    try {
      if (this.cameraInitialized) {
        await CameraPreview.stop();
        this.cameraInitialized = false;
      }
      await new Promise(r => setTimeout(r, 300));
      await this.initCameraPreview(true);
    } catch (e) {
      console.warn('Restart camera error', e);
      this.cameraInitialized = false;
    } finally {
      this.restartInProgress = false;
    }
  }

  async initCameraPreview(silent = false) {
    if (this.cameraInitialized || this.isStartingCamera) return;
    this.isStartingCamera = true;
    try {
      try {
        const isStarted = await CameraPreview.isCameraStarted();
        if (isStarted?.value) {
          this.zone.run(() => { this.cameraInitialized = true; });
          return;
        }
      } catch { }
      try {
        const perm = await Camera.checkPermissions();
        if (perm.camera !== 'granted') {
          const result = await Camera.requestPermissions({ permissions: ['camera'] });
          if (result.camera !== 'granted') {
            if (!silent) this.showToast('Camera permission denied', 'error', 3500);
            return;
          }
        }
      } catch (permErr) {
        console.warn('Camera permission check error', permErr);
      }
      const opts: CameraPreviewOptions = {
        parent: 'camera-preview',
        position: this.isFrontCamera ? 'front' : 'rear',
        toBack: true,
        width: window.innerWidth,
        height: window.innerHeight,
        disableAudio: true,
        enableOpacity: true
      };
      await CameraPreview.start(opts);
      this.photoStamper.startGpsWatch();
      this.zone.run(() => {
        this.cameraInitialized = true;
        this.cdr.detectChanges();
      });
    } catch (e: any) {
      const msg = e?.message || `${e}`;
      if (msg.includes('already started')) {
        this.zone.run(() => {
          this.cameraInitialized = true;
          this.cdr.detectChanges();
        });
      } else if (!silent) {
        this.showToast(`Camera start error: ${msg}`, 'error', 3500);
      }
    } finally {
      this.isStartingCamera = false;
    }
  }

  async stopCameraPreview() {
    this.photoStamper.stopGpsWatch();
    try {
      await CameraPreview.stop();
    } catch (e) {
      console.warn('Stop preview error', e);
    } finally {
      this.zone.run(() => {
        this.cameraInitialized = false;
        this.cdr.detectChanges();
      });
    }
  }

  async toggleFlash() {
    if (this.isFrontCamera) return;
    try {
      this.isFlashOn = !this.isFlashOn;
      await CameraPreview.setFlashMode({ flashMode: this.isFlashOn ? 'torch' : 'off' });
    } catch (e) {
      this.zone.run(() => { this.isFlashOn = false; });
    }
  }

  async flipCamera() {
    try {
      await CameraPreview.flip();
      this.zone.run(() => {
        this.isFrontCamera = !this.isFrontCamera;
        if (this.isFrontCamera && this.isFlashOn) {
          this.isFlashOn = false;
        }
      });
    } catch (e) {
      console.warn('Flip error', e);
    }
  }

  toggleGrid() {
    this.zone.run(() => { this.isGridVisible = !this.isGridVisible; });
  }

  async openSettings() {
    await this.stopCameraPreview();
    const modal = await this.modalController.create({
      component: SettingsComponent,
      breakpoints: [0, 1],
      initialBreakpoint: 1,
      cssClass: 'settings-modal'
    });
    await modal.present();
    const { data } = await modal.onWillDismiss();
    if (data?.saved) {
      this.isGridVisible = this.settingsService.settings.showGridOnStart;
      this.isFrontCamera = this.settingsService.settings.defaultCamera === 'front';
    }
    await this.initCameraPreview();
  }

  async openGallery() {
    this.zone.run(() => {
      this.viewingGallery = true;
      this.selectedGalleryPhoto = null;
      this.selectedGalleryPhotoIndex = null;
      this.allGalleryPhotos = this.photoStamper.cachedGallery;
      this.cdr.detectChanges();
    });
    await this.stopCameraPreview();
    try {
      const fresh = await this.photoStamper.getSavedPhotos(cached => {
        this.zone.run(() => {
          this.allGalleryPhotos = cached;
          this.cdr.detectChanges();
        });
      });
      this.zone.run(() => {
        this.allGalleryPhotos = fresh;
        this.cdr.detectChanges();
      });
    } catch (e) {
      console.warn('Gallery load error', e);
    }
  }

  async closeGallery() {
    this.zone.run(() => {
      this.viewingGallery = false;
      this.selectedGalleryPhoto = null;
      this.selectedGalleryPhotoIndex = null;
      this.touchDeltaX = 0;
      this.isSwiping = false;
      this.cdr.detectChanges();
    });
    await this.initCameraPreview();
  }

  get lightboxTransform(): string {
    if (this.isSwiping && this.touchDeltaX !== 0) {
      return `translateX(${this.touchDeltaX}px)`;
    }
    return 'translateX(0)';
  }

  get lightboxTransition(): string {
    return this.isSwiping ? 'none' : 'transform 0.22s cubic-bezier(0.2, 0.9, 0.4, 1)';
  }

  viewPhotoDetail(photoOrIndex: string | number) {
    let idx: number;
    if (typeof photoOrIndex === 'number') {
      idx = photoOrIndex;
    } else {
      idx = this.allGalleryPhotos.indexOf(photoOrIndex);
    }
    if (idx < 0) idx = 0;
    this.zone.run(() => {
      this.selectedGalleryPhotoIndex = idx;
      this.selectedGalleryPhoto = this.allGalleryPhotos[idx] || null;
      this.touchDeltaX = 0;
      this.isSwiping = false;
    });
  }

  closePhotoDetail() {
    this.zone.run(() => {
      this.selectedGalleryPhotoIndex = null;
      this.selectedGalleryPhoto = null;
      this.touchDeltaX = 0;
      this.isSwiping = false;
    });
  }

  prevPhoto(event?: Event) {
    if (event) event.stopPropagation();
    if (this.selectedGalleryPhotoIndex !== null && this.selectedGalleryPhotoIndex > 0) {
      this.zone.run(() => {
        this.selectedGalleryPhotoIndex!--;
        this.selectedGalleryPhoto = this.allGalleryPhotos[this.selectedGalleryPhotoIndex!];
        this.touchDeltaX = 0;
        this.isSwiping = false;
      });
    }
  }

  nextPhoto(event?: Event) {
    if (event) event.stopPropagation();
    if (
      this.selectedGalleryPhotoIndex !== null &&
      this.selectedGalleryPhotoIndex < this.allGalleryPhotos.length - 1
    ) {
      this.zone.run(() => {
        this.selectedGalleryPhotoIndex!++;
        this.selectedGalleryPhoto = this.allGalleryPhotos[this.selectedGalleryPhotoIndex!];
        this.touchDeltaX = 0;
        this.isSwiping = false;
      });
    }
  }

  onTouchStart(e: TouchEvent) {
    if (e.touches && e.touches.length === 1) {
      this.touchStartX = e.touches[0].clientX;
      this.touchStartY = e.touches[0].clientY;
      this.touchDeltaX = 0;
      this.isSwiping = true;
    }
  }

  onTouchMove(e: TouchEvent) {
    if (!this.isSwiping || !e.touches || e.touches.length !== 1) return;
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = currentX - this.touchStartX;
    const deltaY = currentY - this.touchStartY;

    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      this.touchDeltaX = deltaX;
    }
  }

  onTouchEnd() {
    if (!this.isSwiping) return;
    this.isSwiping = false;
    const swipeThreshold = 45;

    if (this.touchDeltaX < -swipeThreshold) {
      this.nextPhoto();
    } else if (this.touchDeltaX > swipeThreshold) {
      this.prevPhoto();
    }
    this.touchDeltaX = 0;
  }

  private async setupBackButtonListener() {
    try {
      this.backButtonSub = await App.addListener('backButton', async () => {
        const modal = await this.modalController.getTop();
        if (modal) {
          await modal.dismiss();
          return;
        }

        if (this.selectedGalleryPhotoIndex !== null) {
          this.closePhotoDetail();
          return;
        }

        if (this.viewingGallery) {
          await this.closeGallery();
          return;
        }

        await App.exitApp();
      });
    } catch (e) {
      console.warn('Back button listener error', e);
    }
  }

  async captureImage() {
    if (this.isCapturing) return;
    this.isCapturing = true;
    this.shutterFlashing = true;
    this.cdr.detectChanges();

    setTimeout(() => {
      this.shutterFlashing = false;
      this.cdr.detectChanges();
    }, 120);

    let base64Image: string;
    try {
      const q = this.settingsService.settings.photoQuality;
      const result = await CameraPreview.capture({ quality: q });
      base64Image = `data:image/jpeg;base64,${result.value}`;
    } catch (captureErr) {
      console.error('Capture error:', captureErr);
      this.showToast('Capture failed', 'error', 3000);
      this.isCapturing = false;
      this.cdr.detectChanges();
      return;
    }

    this.isCapturing = false;
    this.allGalleryPhotos = [base64Image, ...this.allGalleryPhotos];
    this.cdr.detectChanges();

    this.photoStamper.processAndSavePhoto(base64Image)
      .then(() => this.photoStamper.getSavedPhotos())
      .then(photos => {
        this.zone.run(() => {
          this.allGalleryPhotos = photos;
          this.cdr.detectChanges();
        });
      })
      .catch(e => {
        console.warn('Process photo error', e);
        this.zone.run(() => {
          this.cdr.detectChanges();
        });
      });
  }
}
