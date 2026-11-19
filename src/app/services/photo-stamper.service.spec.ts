import { TestBed } from '@angular/core/testing';
import { PhotoStamperService } from './photo-stamper.service';

describe('PhotoStamperService', () => {
  let service: PhotoStamperService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PhotoStamperService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
