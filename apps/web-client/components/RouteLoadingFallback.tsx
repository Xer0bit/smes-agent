import BrandLoader from "./BrandLoader";

export default function RouteLoadingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <BrandLoader variant="cascade" size={100} label="Loading" />
    </div>
  );
}
