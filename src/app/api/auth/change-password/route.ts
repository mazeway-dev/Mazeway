/**
 * This route is for:
 * 1. Authenticated users that want to change their password
 * 2. OAuth users that want to add a password to their account
 *
 * For users that signed up with email/password:
 * - Requires current password verification
 * - Updates to new password if verification succeeds
 *
 * For users that signed up with OAuth:
 * - Skips current password verification
 * - Adds password to their account
 * - Keeps OAuth provider connected
 */

import { createClient } from "@/utils/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import {
  TApiErrorResponse,
  TEmptySuccessResponse,
  TPasswordChangeResponse,
} from "@/types/api";
import { authRateLimit, getClientIp } from "@/utils/rate-limit";
import {
  hasGracePeriodExpired,
  getUserVerificationMethods,
  getUser,
  getDeviceSessionId,
} from "@/utils/auth";
import {
  passwordChangeSchema,
  addPasswordSchema,
  type PasswordChangeSchema,
} from "@/validation/auth-validation";
import { AUTH_CONFIG } from "@/config/auth";
import { sendEmailAlert } from "@/utils/email-alerts";
import { logAccountEvent } from "@/utils/account-events/server";
import { UAParser } from "ua-parser-js";

export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url);

  try {
    // Rate limiting
    if (authRateLimit) {
      const ip = getClientIp(request);
      const { success } = await authRateLimit.limit(ip);

      if (!success) {
        console.warn(`[Password Change] Rate limit exceeded for IP: ${ip}`);
        return NextResponse.json(
          {
            error: "Too many requests. Please try again later.",
          },
          { status: 429 }
        ) satisfies NextResponse<TApiErrorResponse>;
      }
    }

    const supabase = await createClient();
    const supabaseAdmin = await createClient({ useServiceRole: true });

    const { user, error } = await getUser({ supabase });
    if (error || !user) {
      console.error("[Password Change] Unauthorized access attempt:", error);
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      ) satisfies NextResponse<TApiErrorResponse>;
    }

    // Get user data including has_password
    const { data: dbUser, error: dbError } = await supabase
      .from("users")
      .select("has_password")
      .eq("id", user.id)
      .single();

    if (dbError || !dbUser) {
      console.error("[Password Change] Failed to fetch user data:", dbError);
      return NextResponse.json(
        { error: "Failed to get user data" },
        { status: 500 }
      ) satisfies NextResponse<TApiErrorResponse>;
    }

    const body = await request.json();

    // If not a 2FA request, validate password change data
    const validation = (
      dbUser.has_password ? passwordChangeSchema : addPasswordSchema
    ).safeParse(body);
    if (!validation.success) {
      console.warn(
        "[Password Change] Validation failed:",
        validation.error.issues
      );
      return NextResponse.json(
        { error: validation.error.issues[0]?.message || "Invalid input" },
        { status: 400 }
      ) satisfies NextResponse<TApiErrorResponse>;
    }

    // Type-safe way to handle both schemas
    const { newPassword } = validation.data;
    const currentPassword = dbUser.has_password
      ? (validation.data as PasswordChangeSchema).currentPassword
      : undefined;

    // For users with password auth, verify current password
    if (dbUser.has_password) {
      if (!currentPassword) {
        console.warn(
          "[Password Change] Current password missing for password change"
        );
        return NextResponse.json(
          { error: "Current password is required" },
          { status: 400 }
        ) satisfies NextResponse<TApiErrorResponse>;
      }

      // Verify current password
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email!,
        password: currentPassword,
      });

      if (signInError) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 400 }
        ) satisfies NextResponse<TApiErrorResponse>;
      }
    }

    // Get device session ID from cookie
    const deviceSessionId = getDeviceSessionId(request);
    if (!deviceSessionId) {
      console.error("[Password Change] No device session found in request");
      return NextResponse.json(
        { error: "No device session found" },
        { status: 400 }
      ) satisfies NextResponse<TApiErrorResponse>;
    }

    // Check if verification is needed;
    const gracePeriodExpired = await hasGracePeriodExpired({
      supabase,
      deviceSessionId,
    });

    if (gracePeriodExpired) {
      // Check if user has 2FA enabled
      const { has2FA, factors } = await getUserVerificationMethods({
        supabase,
        supabaseAdmin,
      });

      if (has2FA) {
        return NextResponse.json({
          requiresTwoFactor: true,
          factorId: factors[0].factorId,
          availableMethods: factors,
          newPassword,
        }) satisfies NextResponse<TPasswordChangeResponse>;
      }

      // Log sensitive action verification
      const parser = new UAParser(request.headers.get("user-agent") || "");
      await logAccountEvent({
        user_id: user.id,
        event_type: "SENSITIVE_ACTION_VERIFIED",
        device_session_id: deviceSessionId,
        metadata: {
          device: {
            device_name: parser.getDevice().model || "Unknown Device",
            browser: parser.getBrowser().name || null,
            os: parser.getOS().name || null,
            ip_address: getClientIp(request),
          },
          action: "change_password",
          category: "info",
          description: "Password change request verified",
        },
      });
    }

    // If no 2FA required or within grace period, update password
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      // Special handling for OAuth users
      if (
        dbUser.has_password &&
        updateError.message.includes("identity_not_found")
      ) {
        return NextResponse.json(
          { error: "Cannot add password. Please contact support." },
          { status: 400 }
        ) satisfies NextResponse<TApiErrorResponse>;
      }
      throw updateError;
    }

    // Update has_password flag
    const { error: flagError } = await supabase
      .from("users")
      .update({ has_password: true })
      .eq("id", user.id);

    if (flagError) {
      console.error(
        "[Password Change] Failed to update has_password flag:",
        flagError
      );
      // Don't throw - password was updated successfully
    }

    // Log the password change event
    const parser = new UAParser(request.headers.get("user-agent") || "");
    await logAccountEvent({
      user_id: user.id,
      event_type: "PASSWORD_CHANGED",
      device_session_id: deviceSessionId,
      metadata: {
        device: {
          device_name: parser.getDevice().model || "Unknown Device",
          browser: parser.getBrowser().name || null,
          os: parser.getOS().name || null,
          ip_address: getClientIp(request),
        },
        category: "warning",
        description: "Account password was changed",
      },
    });

    // Send email alert for password change
    if (
      AUTH_CONFIG.emailAlerts.password.enabled &&
      AUTH_CONFIG.emailAlerts.password.alertOnChange
    ) {
      await sendEmailAlert({
        request,
        origin,
        user,
        title: "Your password was changed",
        message:
          "Your account password was just changed. If this wasn't you, please secure your account immediately.",
      });
    }

    return NextResponse.json({}) satisfies NextResponse<TEmptySuccessResponse>;
  } catch (error) {
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    ) satisfies NextResponse<TApiErrorResponse>;
  }
}
