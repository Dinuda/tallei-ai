import { NextRequest } from "next/server";
export declare function GET(req: NextRequest, context: {
    params: Promise<{
        path?: string[];
    }>;
}): Promise<Response>;
export declare function POST(req: NextRequest, context: {
    params: Promise<{
        path?: string[];
    }>;
}): Promise<Response>;
//# sourceMappingURL=route.d.ts.map