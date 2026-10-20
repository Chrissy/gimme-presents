export interface ListSummary {
  id: number;
  name: string;
  slug: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Gift {
  id: number;
  name: string;
  url: string;
  image: string;
  priceCents: number | null;
  position: number;
}

export interface ListResponse {
  list: ListSummary;
  gifts: Gift[];
  canEdit: boolean;
}

export interface MeResponse {
  lists: ListSummary[];
}

export interface LocalListSummary {
  id: number;
  name: string;
  slug: string;
  createdAt: string;
  giftCount: number;
}

export interface LocalListsResponse {
  lists: LocalListSummary[];
}

export interface GiftInput {
  name: string;
  url: string;
  image: string;
  /** Dollar amount as entered by the user; blank means no price. */
  price: string;
}

export interface ApiError {
  error: string;
}
