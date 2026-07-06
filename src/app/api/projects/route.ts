import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeProjectBudgetStatus } from "@/lib/budget-status";

export async function GET() {
  try {
    const status = await computeProjectBudgetStatus();
    return NextResponse.json(status.projects);
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, description, monthlyBudgetUsd } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Project name is required" },
        { status: 400 }
      );
    }

    const existing = await prisma.project.findUnique({
      where: { name },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Project name already exists" },
        { status: 400 }
      );
    }

    const project = await prisma.project.create({
      data: {
        name,
        description,
        monthlyBudgetUsd,
      },
    });

    return NextResponse.json(project);
  } catch (error) {
    console.error("Failed to create project:", error);
    return NextResponse.json(
      { error: "Failed to create project" },
      { status: 500 }
    );
  }
}
