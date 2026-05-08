import { NextResponse } from "next/server";
import { getProviderPoolById, updateProviderPool, deleteProviderPool } from "@/lib/localDb";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const pool = await getProviderPoolById(id);
    if (!pool) {
      return NextResponse.json({ error: "Provider pool not found" }, { status: 404 });
    }
    return NextResponse.json({ pool });
  } catch (error) {
    console.log("Error fetching provider pool:", error);
    return NextResponse.json({ error: "Failed to fetch provider pool" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, providerIds } = body;

    const updateData = {};
    if (name !== undefined) {
      if (!name || !name.trim()) {
        return NextResponse.json({ error: "Name is required" }, { status: 400 });
      }
      updateData.name = name.trim();
    }

    if (providerIds !== undefined) {
      if (!Array.isArray(providerIds)) {
        return NextResponse.json({ error: "providerIds must be an array" }, { status: 400 });
      }
      updateData.providerIds = providerIds;
    }

    const updated = await updateProviderPool(id, updateData);
    if (!updated) {
      return NextResponse.json({ error: "Provider pool not found" }, { status: 404 });
    }

    return NextResponse.json({ pool: updated });
  } catch (error) {
    console.log("Error updating provider pool:", error);
    return NextResponse.json({ error: "Failed to update provider pool" }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const ok = await deleteProviderPool(id);
    if (!ok) {
      return NextResponse.json({ error: "Provider pool not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider pool:", error);
    return NextResponse.json({ error: "Failed to delete provider pool" }, { status: 500 });
  }
}
