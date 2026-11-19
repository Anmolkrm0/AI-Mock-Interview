"use client";

import { api } from "@/lib/api";
import type { AdminContactMessageListOut } from "@/types/api";

export interface ContactInput {
  name: string;
  email: string;
  message: string;
  captcha_token?: string | null;
}

export const contactApi = {
  submit(data: ContactInput) {
    return api<{ status: string; message_id: string }>("/contact", {
      method: "POST",
      body: data,
      public: true,
    });
  },
  listAdminMessages(limit = 50, offset = 0) {
    return api<AdminContactMessageListOut>(`/admin/messages?limit=${limit}&offset=${offset}`, {
      method: "GET",
    });
  },
  handleAdminMessage(messageId: string) {
    return api<{ status: string; message_id: string }>(`/admin/messages/${messageId}/handle`, {
      method: "POST",
    });
  },
};
