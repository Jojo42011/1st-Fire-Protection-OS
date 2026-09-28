/**
 * Offices on the NFC review page (/review). To change a link, edit `reviewUrl` here and deploy.
 *
 * `reviewUrl` is the office's Google "leave a review" link (Google Business Profile, then
 * "Ask for reviews", then copy the link). Leave it empty to use the link mapped for that office on
 * Reviews, then Review requests (matched by `match`); an office with no link from either place is
 * hidden rather than shown broken.
 *
 * Every link below was checked on 9/28/2026: each opens Google's write-a-review form for its office.
 */
export interface ReviewOffice {
  slug: string;
  name: string;
  reviewUrl: string;
  match: string;
}

export const REVIEW_OFFICES: ReviewOffice[] = [
  { slug: 'austin', name: 'Austin', reviewUrl: 'https://g.page/r/CTADSKrm3eATEBM/review', match: 'austin' },
  { slug: 'college-station', name: 'College Station', reviewUrl: 'https://g.page/r/CbPMR0sCiphFEBM/review', match: 'college station' },
  { slug: 'houston', name: 'Houston', reviewUrl: 'https://g.page/r/Cd6k5KxBJuA9EBM/review', match: 'houston' },
  { slug: 'laredo', name: 'Laredo', reviewUrl: '', match: 'laredo' },
  { slug: 'lubbock', name: 'Lubbock', reviewUrl: 'https://g.page/r/CaAK0W-cCO9_EBM/review', match: 'lubbock' },
  { slug: 'mcallen', name: 'McAllen', reviewUrl: 'https://g.page/r/CfhCsw3FsT0BEBM/review', match: 'mcallen' },
  // 1st FP Services and 1st FP Extinguishers share this Google profile.
  { slug: 'san-antonio', name: 'San Antonio', reviewUrl: 'https://g.page/r/CbfDslKUGQ-dEBM/review', match: 'services' },
  { slug: 'waco', name: 'Waco', reviewUrl: 'https://g.page/r/CfMy6b6AkmsrEBM/review', match: 'waco' },
];
