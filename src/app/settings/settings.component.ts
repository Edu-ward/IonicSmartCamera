import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonButtons,
  IonList, IonListHeader, IonItem, IonLabel, IonToggle, IonSelect,
  IonSelectOption, IonRange, IonIcon, AlertController
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  cameraOutline, locationOutline, mapOutline, imageOutline,
  colorPaletteOutline, informationCircleOutline, refreshOutline,
  timeOutline, textOutline, contrastOutline, gridOutline
} from 'ionicons/icons';
import { ModalController } from '@ionic/angular';
import { SettingsService, AppSettings } from '../services/settings.service';

@Component({
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonButtons,
    IonList, IonListHeader, IonItem, IonLabel, IonToggle, IonSelect,
    IonSelectOption, IonRange, IonIcon
  ]
})
export class SettingsComponent implements OnInit {
  settings!: AppSettings;

  constructor(
    private modalController: ModalController,
    private settingsService: SettingsService,
    private alertController: AlertController
  ) {
    addIcons({
      cameraOutline, locationOutline, mapOutline, imageOutline,
      colorPaletteOutline, informationCircleOutline, refreshOutline,
      timeOutline, textOutline, contrastOutline, gridOutline
    });
  }

  ngOnInit() {
    this.settings = JSON.parse(JSON.stringify(this.settingsService.settings));
  }

  async save() {
    await this.settingsService.update(this.settings);
    await this.modalController.dismiss({ saved: true });
  }

  dismiss() {
    this.modalController.dismiss({ saved: false });
  }

  async resetDefaults() {
    const alert = await this.alertController.create({
      header: 'Reset to Defaults',
      message: 'All settings will be restored to their factory defaults. Continue?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Reset',
          role: 'destructive',
          handler: async () => {
            await this.settingsService.reset();
            this.settings = JSON.parse(JSON.stringify(this.settingsService.settings));
          }
        }
      ]
    });
    await alert.present();
  }

  get qualityLabel(): string {
    if (this.settings.photoQuality >= 90) return 'Maximum';
    if (this.settings.photoQuality >= 75) return 'High';
    if (this.settings.photoQuality >= 50) return 'Medium';
    return 'Low';
  }

  get zoomLabel(): string {
    const labels: Record<number, string> = { 1: 'Street', 2: 'Block', 3: 'Neighborhood', 4: 'District', 5: 'City', 6: 'Region', 7: 'Wide', 8: 'Very Wide', 9: 'Country', 10: 'Continent' };
    return labels[this.settings.mapZoomOffset] ?? 'District';
  }
}
