"use client";

import { useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogOut, User, Settings, ChevronDown } from "lucide-react";
import { useAuthStore } from "@/stores/auth.store";
import { Avatar } from "@/components/ui/avatar";
import { cn, getInitials } from "@/lib/utils";

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const router = useRouter();

  // Close on click outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleLogout = async () => {
    setOpen(false);
    await logout();
    router.replace("/login");
  };

  if (!user) return null;

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-100 transition-colors"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Avatar
          initials={getInitials(user.firstName, user.lastName)}
          src={user.avatarUrl}
          size="sm"
        />
        <div className="hidden md:block text-left min-w-0">
          <p className="text-xs font-medium text-zinc-800 leading-tight truncate max-w-[120px]">
            {user.firstName} {user.lastName}
          </p>
          <p className="text-[10px] text-zinc-400 leading-tight truncate max-w-[120px]">
            {user.email}
          </p>
        </div>
        <ChevronDown
          className={cn(
            "hidden md:block h-3.5 w-3.5 text-zinc-400 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-56 rounded-xl border border-zinc-200 bg-white shadow-card-lg py-1.5 z-50 animate-fade-in"
        >
          {/* User info header */}
          <div className="px-3 py-2.5 border-b border-zinc-100">
            <p className="text-sm font-medium text-zinc-900">
              {user.firstName} {user.lastName}
            </p>
            <p className="text-xs text-zinc-500 truncate">{user.email}</p>
            <span className="mt-1.5 inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 capitalize">
              {user.role.replace(/_/g, " ").toLowerCase()}
            </span>
          </div>

          {/* Menu items */}
          <div className="py-1">
            <MenuItem icon={User} label="Your profile" onClick={() => setOpen(false)} />
            <MenuItem
              icon={Settings}
              label="Security"
              onClick={() => { setOpen(false); router.push("/dashboard/settings/security"); }}
            />
          </div>

          <div className="border-t border-zinc-100 py-1">
            <MenuItem
              icon={LogOut}
              label="Sign out"
              onClick={handleLogout}
              className="text-red-600 hover:bg-red-50"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  className,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 transition-colors",
        className,
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-zinc-400" />
      {label}
    </button>
  );
}
