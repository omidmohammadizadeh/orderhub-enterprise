"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Camera, Trash2, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import { authClient } from "@/lib/api/auth.client";
import { useAuthStore } from "@/stores/auth.store";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getInitials } from "@/lib/utils";

// Shared modal shell — fixed overlay, centered card, click-out + close.
function Modal({
  title,
  onClose,
  children,
  widthClass = "max-w-md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        className={`w-full ${widthClass} rounded-2xl bg-white shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5">
          <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

// Resize/crop an uploaded image to a small square JPEG data URI so the
// avatar stays light enough to store inline.
function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas unsupported"));
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = URL.createObjectURL(file);
  });
}

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const refreshUser = useAuthStore((s) => s.refreshUser);
  const fileRef = useRef<HTMLInputElement>(null);

  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    user?.avatarUrl ?? null,
  );
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  if (!user) return null;

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      setAvatarUrl(await fileToAvatarDataUrl(file));
    } catch {
      toast.error("Couldn't load that image");
    }
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await authClient.updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        avatarUrl: avatarUrl ?? "",
      });
      await refreshUser();
      toast.success("Profile updated");
    } catch {
      toast.error("Couldn't update profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async () => {
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    setSavingPassword(true);
    try {
      await authClient.changePassword({
        currentPassword: currentPassword || undefined,
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed");
    } catch (err: any) {
      toast.error(
        err?.response?.data?.message ?? "Couldn't change password",
      );
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <Modal title="Your profile" onClose={onClose}>
      {/* Avatar + email */}
      <div className="flex items-center gap-4">
        <div className="relative">
          <Avatar
            initials={getInitials(firstName, lastName)}
            src={avatarUrl}
            size="lg"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="absolute -bottom-1 -right-1 rounded-full border border-zinc-200 bg-white p-1.5 shadow-sm hover:bg-zinc-50"
            aria-label="Change photo"
          >
            <Camera className="h-3.5 w-3.5 text-zinc-600" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickFile}
          />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-900">Email</p>
          <p className="truncate text-sm text-zinc-500">{user.email}</p>
        </div>
      </div>

      {/* Name */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="firstName">First name</Label>
          <Input
            id="firstName"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="lastName">Last name</Label>
          <Input
            id="lastName"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button onClick={saveProfile} loading={savingProfile} size="sm">
          Save profile
        </Button>
      </div>

      {/* Change password */}
      <div className="mt-5 border-t border-zinc-100 pt-4">
        <p className="text-sm font-semibold text-zinc-900">Change password</p>
        <div className="mt-3 space-y-3">
          <div>
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            onClick={savePassword}
            loading={savingPassword}
            size="sm"
            variant="outline"
            disabled={!newPassword}
          >
            Change password
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const clearTokens = useAuthStore((s) => s.clearTokens);
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const PHRASE = "DELETE MY ACCOUNT";

  const submit = async () => {
    if (confirmText !== PHRASE) return;
    setDeleting(true);
    try {
      await authClient.deleteAccount(PHRASE);
      clearTokens();
      toast.success("Your account has been deleted");
      router.replace("/login");
    } catch (err: any) {
      toast.error(
        err?.response?.data?.message ?? "Couldn't delete account",
      );
      setDeleting(false);
    }
  };

  return (
    <Modal title="Delete my account" onClose={onClose}>
      {step === 1 ? (
        <>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full bg-red-50 p-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-900">
                Are you sure you want to delete your account?
              </p>
              <p className="mt-1 text-sm text-zinc-500">
                This permanently removes your account and your personal data
                from our system. This action cannot be undone.
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => setStep(2)}
            >
              Yes, continue
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600">
            To confirm, type{" "}
            <span className="font-semibold text-zinc-900">{PHRASE}</span> below.
          </p>
          <Input
            className="mt-3"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={PHRASE}
            autoFocus
          />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={deleting}
              disabled={confirmText !== PHRASE}
              className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              onClick={submit}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              Permanently delete
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
