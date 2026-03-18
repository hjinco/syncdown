import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
	useRouter,
} from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import {
	docsI18nUI,
	getAppMetadata,
	isLocale,
	localizePath,
	useCurrentLocale,
} from "@/lib/i18n";
import appCss from "@/styles/app.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
		],
		links: [{ rel: "stylesheet", href: appCss }],
	}),
	component: RootComponent,
});

function RootComponent() {
	const locale = useCurrentLocale();
	const router = useRouter();
	const i18n = docsI18nUI.provider(locale);
	const { title, description } = getAppMetadata(locale);

	return (
		<html suppressHydrationWarning lang={locale}>
			<head>
				<HeadContent />
				<title>{title}</title>
				<meta content={description} name="description" />
			</head>
			<body className="flex flex-col min-h-screen">
				<RootProvider
					i18n={{
						...i18n,
						onLocaleChange(nextLocale) {
							if (!isLocale(nextLocale)) return;

							const currentPath =
								typeof window === "undefined"
									? "/"
									: `${window.location.pathname}${window.location.search}${window.location.hash}`;

							router.navigate({
								href: localizePath(currentPath, nextLocale),
							});
						},
					}}
				>
					<Outlet />
				</RootProvider>
				<Scripts />
			</body>
		</html>
	);
}
